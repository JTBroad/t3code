/**
 * CopilotAdapter — ProviderAdapter implementation backed by
 * `@github/copilot-sdk`.
 *
 * One `CopilotClient` (spawned CLI over stdio JSON-RPC) per session, one
 * `CopilotSession` per thread. SDK session events are serialized through a
 * promise chain into canonical `ProviderRuntimeEvent`s (see
 * `.plans/21-copilot-adapter.md` for the full translation map).
 *
 * @module provider/Layers/CopilotAdapter
 */
import {
  type CopilotSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  CopilotClient,
  type CopilotSession,
  type SessionEvent,
} from "@github/copilot-sdk";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { makeCopilotClientOptions } from "./CopilotProvider.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("copilot");

export interface CopilotAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CopilotTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface CopilotSessionContext {
  session: ProviderSession;
  readonly client: CopilotClient;
  readonly copilotSession: CopilotSession;
  readonly copilotSessionId: string;
  readonly turns: Array<CopilotTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  /** Provider-side turn id from `assistant.turn_start` (for providerRefs). */
  providerTurnId: string | undefined;
  /** Serializes SDK event handling in arrival order. */
  eventChain: Promise<void>;
  /** Running token totals across the thread. */
  totalInputTokens: number;
  totalOutputTokens: number;
  readonly stopped: Ref.Ref<boolean>;
  unsubscribe: (() => void) | undefined;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly messageType?: string | undefined;
  readonly raw?: unknown;
};

export function toCopilotToolLifecycleItemType(
  toolName: string,
  mcpServerName?: string,
): ToolLifecycleItemType {
  if (mcpServerName) {
    return "mcp_tool_call";
  }
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("create_file") ||
    normalized.includes("patch")
  ) {
    return "file_change";
  }
  if (normalized.includes("web") || normalized.includes("fetch") || normalized.includes("url")) {
    return "web_search";
  }
  if (normalized.includes("image") || normalized === "view_image") {
    return "image_view";
  }
  if (normalized.includes("task") || normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, CopilotSessionContext>,
  threadId: ThreadId,
): CopilotSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
}

const toRequestError = (method: string, cause: unknown): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Run an SDK promise, mapping rejection to a typed request error. */
const runSdk = <A>(method: string, run: () => Promise<A>) =>
  Effect.tryPromise(run).pipe(Effect.mapError((cause) => toRequestError(method, cause.cause)));

function resolveTurnSnapshot(context: CopilotSessionContext, turnId: TurnId): CopilotTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }
  const created: CopilotTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function updateProviderSession(
  context: CopilotSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

/** Resume-cursor shape persisted per thread. */
export interface CopilotResumeState {
  readonly copilotSessionId?: string;
}

export function readCopilotResumeState(resumeCursor: unknown): CopilotResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as { copilotSessionId?: unknown };
  return typeof cursor.copilotSessionId === "string" && cursor.copilotSessionId.length > 0
    ? { copilotSessionId: cursor.copilotSessionId }
    : undefined;
}

export function makeCopilotAdapter(
  copilotSettings: CopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("copilot");
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const nativeEventLogger = options?.nativeEventLogger;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, CopilotSessionContext>();

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => toRequestError("crypto/randomUUIDv4", cause)),
    );

    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "copilot.sdk.event" as const,
                  ...(input.messageType ? { messageType: input.messageType } : {}),
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const writeNativeEventBestEffort = (threadId: ThreadId, event: Record<string, unknown>) =>
      nativeEventLogger
        ? Effect.flatMap(nowIso, (observedAt) =>
            nativeEventLogger.write({ observedAt, event }, threadId),
          ).pipe(Effect.catchCause(() => Effect.void))
        : Effect.void;

    const stopCopilotContext = Effect.fn("stopCopilotContext")(function* (
      context: CopilotSessionContext,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return false;
      }
      context.unsubscribe?.();
      yield* Effect.tryPromise(async () => {
        await context.copilotSession.disconnect().catch(() => undefined);
        await context.client.stop().catch(() => context.client.forceStop().catch(() => undefined));
      }).pipe(Effect.ignore);
      return true;
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopCopilotContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const completeActiveTurn = Effect.fn("completeActiveTurn")(function* (
      context: CopilotSessionContext,
      input: {
        readonly state: "completed" | "failed" | "interrupted";
        readonly errorMessage?: string | undefined;
        readonly raw?: unknown;
        readonly messageType?: string | undefined;
      },
    ) {
      const turnId = context.activeTurnId;
      if (!turnId) {
        return;
      }
      context.activeTurnId = undefined;
      context.providerTurnId = undefined;
      yield* updateProviderSession(
        context,
        input.state === "failed"
          ? { status: "error", ...(input.errorMessage ? { lastError: input.errorMessage } : {}) }
          : { status: "ready" },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          messageType: input.messageType,
          raw: input.raw,
        })),
        type: "turn.completed",
        payload: {
          state: input.state,
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        },
      });
    });

    /**
     * Translate one SDK session event into canonical runtime events.
     * Invoked strictly in arrival order via the per-session promise chain.
     */
    const handleSessionEvent = Effect.fn("handleSessionEvent")(function* (
      context: CopilotSessionContext,
      event: SessionEvent,
    ) {
      if (Ref.getUnsafe(context.stopped)) {
        return;
      }
      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      const data: Record<string, unknown> =
        "data" in event && event.data && typeof event.data === "object"
          ? (event.data as Record<string, unknown>)
          : {};

      yield* writeNativeEventBestEffort(threadId, {
        provider: PROVIDER,
        threadId,
        providerThreadId: context.copilotSessionId,
        type: event.type,
        ...(turnId ? { turnId } : {}),
        payload: event,
      });

      switch (event.type) {
        case "assistant.turn_start": {
          context.providerTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
          break;
        }

        case "assistant.message_delta": {
          const delta = typeof data.deltaContent === "string" ? data.deltaContent : "";
          if (delta.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: typeof data.messageId === "string" ? data.messageId : undefined,
              messageType: event.type,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta,
            },
          });
          break;
        }

        case "assistant.reasoning_delta": {
          const delta = typeof data.deltaContent === "string" ? data.deltaContent : "";
          if (delta.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: typeof data.reasoningId === "string" ? data.reasoningId : undefined,
              messageType: event.type,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta,
            },
          });
          break;
        }

        case "assistant.message": {
          const content = typeof data.content === "string" ? data.content : "";
          const itemId = typeof data.messageId === "string" ? data.messageId : event.id;
          resolveTurnSnapshot(context, turnId ?? TurnId.make(`copilot-orphan-${event.id}`)).items.push(
            event,
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId,
              messageType: event.type,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(content.length > 0 ? { detail: content } : {}),
            },
          });
          break;
        }

        case "assistant.reasoning": {
          const content = typeof data.content === "string" ? data.content : "";
          if (content.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: typeof data.reasoningId === "string" ? data.reasoningId : event.id,
              messageType: event.type,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              detail: content,
            },
          });
          break;
        }

        case "tool.execution_start": {
          const toolName = typeof data.toolName === "string" ? data.toolName : "tool";
          const mcpServerName =
            typeof data.mcpServerName === "string" ? data.mcpServerName : undefined;
          const itemType = toCopilotToolLifecycleItemType(toolName, mcpServerName);
          const shellInfo =
            data.shellToolInfo && typeof data.shellToolInfo === "object"
              ? (data.shellToolInfo as Record<string, unknown>)
              : undefined;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: typeof data.toolCallId === "string" ? data.toolCallId : event.id,
              messageType: event.type,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: mcpServerName ? `${mcpServerName}: ${toolName}` : toolName,
              data: {
                toolName,
                ...(data.arguments !== undefined ? { arguments: data.arguments } : {}),
                ...(shellInfo ? { shellToolInfo: shellInfo } : {}),
                ...(mcpServerName ? { mcpServerName } : {}),
              },
            },
          });
          break;
        }

        case "tool.execution_progress": {
          const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
          const progress =
            typeof data.progressMessage === "string"
              ? data.progressMessage
              : typeof data.message === "string"
                ? data.message
                : undefined;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: toolCallId,
              messageType: event.type,
              raw: event,
            })),
            type: "tool.progress",
            payload: {
              ...(toolCallId ? { toolUseId: toolCallId } : {}),
              ...(progress ? { summary: progress } : {}),
            },
          });
          break;
        }

        case "tool.execution_complete": {
          const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : event.id;
          const success = data.success === true;
          const result =
            data.result && typeof data.result === "object"
              ? (data.result as Record<string, unknown>)
              : undefined;
          const error =
            data.error && typeof data.error === "object"
              ? (data.error as Record<string, unknown>)
              : undefined;
          const detail = success
            ? typeof result?.content === "string"
              ? result.content
              : undefined
            : typeof error?.message === "string"
              ? error.message
              : undefined;
          resolveTurnSnapshot(context, turnId ?? TurnId.make(`copilot-orphan-${event.id}`)).items.push(
            event,
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: toolCallId,
              messageType: event.type,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "dynamic_tool_call",
              status: success ? "completed" : "failed",
              ...(detail ? { detail } : {}),
              data: {
                ...(result ? { result } : {}),
                ...(error ? { error } : {}),
              },
            },
          });
          break;
        }

        case "assistant.usage": {
          const inputTokens = typeof data.inputTokens === "number" ? data.inputTokens : 0;
          const outputTokens = typeof data.outputTokens === "number" ? data.outputTokens : 0;
          const cacheReadTokens =
            typeof data.cacheReadTokens === "number" ? data.cacheReadTokens : undefined;
          context.totalInputTokens += inputTokens;
          context.totalOutputTokens += outputTokens;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              messageType: event.type,
              raw: event,
            })),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens: context.totalInputTokens + context.totalOutputTokens,
                inputTokens: context.totalInputTokens,
                outputTokens: context.totalOutputTokens,
                lastInputTokens: inputTokens,
                lastOutputTokens: outputTokens,
                ...(cacheReadTokens !== undefined
                  ? { lastCachedInputTokens: cacheReadTokens }
                  : {}),
                compactsAutomatically: true,
              },
            },
          });
          break;
        }

        case "session.compaction_start": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: event.id,
              messageType: event.type,
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
          });
          break;
        }

        case "session.compaction_complete": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: event.id,
              messageType: event.type,
              raw: event,
            })),
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: "completed",
              title: "Context compacted",
            },
          });
          break;
        }

        case "session.title_changed": {
          const title = typeof data.title === "string" ? data.title : undefined;
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId,
                messageType: event.type,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: { name: title },
            });
          }
          break;
        }

        case "session.idle": {
          yield* completeActiveTurn(context, {
            state: data.aborted === true ? "interrupted" : "completed",
            messageType: event.type,
            raw: event,
          });
          break;
        }

        case "session.error": {
          const message =
            typeof data.message === "string" && data.message.trim().length > 0
              ? data.message
              : "Copilot session error.";
          yield* completeActiveTurn(context, {
            state: "failed",
            errorMessage: message,
            messageType: event.type,
            raw: event,
          });
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              messageType: event.type,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: data,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const attachEventPump = (context: CopilotSessionContext) => {
      const unsubscribe = context.copilotSession.on((event) => {
        context.eventChain = context.eventChain.then(() =>
          runPromise(handleSessionEvent(context, event)).catch(() => undefined),
        );
      });
      context.unsubscribe = unsubscribe;
    };

    const startSession: CopilotAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const directory = input.cwd ?? serverConfig.cwd;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopCopilotContext(existing);
          sessions.delete(input.threadId);
        }

        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const reasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        const resumeState = readCopilotResumeState(input.resumeCursor);

        const client = new CopilotClient({
          ...makeCopilotClientOptions(copilotSettings, options?.environment),
          workingDirectory: directory,
        });

        const started = yield* Effect.tryPromise(async () => {
          await client.start();
          const sessionConfig = {
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(reasoningEffort
              ? { reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh" }
              : {}),
            streaming: true,
          };
          const copilotSession = resumeState?.copilotSessionId
            ? await client.resumeSession(resumeState.copilotSessionId, sessionConfig)
            : await client.createSession(sessionConfig);
          return copilotSession;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail:
                  cause.cause instanceof Error
                    ? cause.cause.message
                    : "Failed to start Copilot session.",
                cause,
              }),
          ),
          Effect.tapError(() => Effect.promise(() => client.stop().catch(() => []))),
        );

        // Guard against a concurrent startSession call racing us.
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          yield* Effect.promise(async () => {
            await started.disconnect().catch(() => undefined);
            await client.stop().catch(() => undefined);
          });
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: { copilotSessionId: started.sessionId },
          createdAt,
          updatedAt: createdAt,
        };

        const context: CopilotSessionContext = {
          session,
          client,
          copilotSession: started,
          copilotSessionId: started.sessionId,
          turns: [],
          activeTurnId: undefined,
          providerTurnId: undefined,
          eventChain: Promise.resolve(),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          stopped: yield* Ref.make(false),
          unsubscribe: undefined,
        };
        sessions.set(input.threadId, context);
        attachEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "Copilot session started",
            resume: { copilotSessionId: started.sessionId },
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.sessionId,
          },
        });

        return session;
      },
    );

    const sendTurn: CopilotAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      // sendTurn while a turn is active is a steer: the prompt joins the
      // running turn rather than opening a new one.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`copilot-turn-${yield* randomUUIDv4}`);

      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const reasoningEffort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");

      const text = input.input?.trim();
      const attachments = (input.attachments ?? []).flatMap((attachment) => {
        const path = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        return path
          ? [{ type: "file" as const, path, displayName: attachment.name }]
          : [];
      });
      if ((!text || text.length === 0) && attachments.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Copilot turns require text input or at least one attachment.",
        });
      }

      // In-session model switch via session.setModel when the selection
      // differs from the session's current model.
      if (
        modelSelection?.model !== undefined &&
        modelSelection.model !== context.session.model
      ) {
        yield* runSdk("session.setModel", () =>
          context.copilotSession.setModel(modelSelection.model, {
            ...(reasoningEffort
              ? { reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh" }
              : {}),
          }),
        );
      }

      context.activeTurnId = turnId;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
        },
        { clearLastError: true },
      );

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          },
        });
      }

      yield* runSdk("session.send", () =>
        context.copilotSession.send({
          prompt: text ?? "",
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      ).pipe(
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                yield* updateProviderSession(
                  context,
                  {
                    status: "ready",
                    lastError: requestError.detail,
                  },
                  { clearActiveTurnId: true },
                );
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                  type: "turn.aborted",
                  payload: {
                    reason: requestError.detail,
                  },
                });
              }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { copilotSessionId: context.copilotSessionId },
      };
    });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        yield* runSdk("session.abort", () => context.copilotSession.abort());
        if (turnId ?? context.activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: turnId ?? context.activeTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      _threadId,
      requestId,
      _decision,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `No pending Copilot approval request: ${requestId} (approvals land in Phase 4).`,
        }),
      );

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
      _threadId,
      requestId,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `No pending Copilot user-input request: ${requestId} (lands in Phase 4).`,
        }),
      );

    const stopSession: CopilotAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopCopilotContext(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: true,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: CopilotAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        return {
          threadId,
          turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        };
      },
    );

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `Copilot does not support rolling back thread ${threadId}.`,
        }),
      );

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopCopilotContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies CopilotAdapterShape;
  });
}
