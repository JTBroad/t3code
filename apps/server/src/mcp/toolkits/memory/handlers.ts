/**
 * Memory toolkit handlers.
 *
 * Every handler opens with `requireMemoryApp()`, so neither a session without the
 * grant nor an environment with the app switched off can reach the store at all.
 *
 * The important property here is that provenance is taken from the invocation
 * scope, never from tool arguments. The scope is issued server-side when the
 * MCP credential is minted, so a model cannot claim to be a different thread or
 * a different project.
 *
 * @module memory/handlers
 */
import { APP_ID_MEMORY, isAppEnabled, McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ServerConfig } from "../../../config.ts";
import { writeArtifact } from "../../../memory/ArtifactStore.ts";
import { appendDailyEntry, readDaily } from "../../../memory/DailyStore.ts";
import { resolveDriveRoot, resolveMemoryRoot } from "../../../memory/MemoryPaths.ts";
import { listNotes, searchNotes } from "../../../memory/NoteStore.ts";
import { resolveProjectForThread } from "../../../memory/ProjectResolution.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoryToolkit } from "./tools.ts";

const DEFAULT_SEARCH_LIMIT = 20;

/**
 * A disk or database fault is not something the model can act on, and the tool
 * contract should stay "recorded" or "capability denied". Dying still surfaces
 * the fault in logs and to the MCP caller.
 */
const dieOnInfrastructureFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.orDie(effect);

/** Where the shared memory store lives for this server. */
const memoryRoot = Effect.fn("memory.root")(function* () {
  const settings = yield* dieOnInfrastructureFailure((yield* ServerSettingsService).getSettings);
  const config = yield* ServerConfig;
  return resolveMemoryRoot(settings, config);
});

/**
 * Require both the session grant and the app being switched on.
 *
 * The toolkit is registered at boot, so a session opened while Memory was
 * enabled keeps its tools after the user disables the app. Checking here is what
 * makes the toggle take effect immediately: an agent must not go on writing to a
 * store the user believes they switched off.
 *
 * Reported as a capability denial rather than a new error type -- from the
 * model's side "this tool is not available to you" is exactly what happened, and
 * a disabled app is not something it can act on differently.
 */
const requireMemoryApp = Effect.fn("memory.requireApp")(function* () {
  const scope = yield* McpInvocationContext.requireMcpCapability("memory");
  const settings = yield* dieOnInfrastructureFailure((yield* ServerSettingsService).getSettings);

  if (!isAppEnabled({ enabledApps: settings.enabledApps, appId: APP_ID_MEMORY })) {
    return yield* new McpCapabilityUnavailableError({
      capability: "memory",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: scope.providerInstanceId,
    });
  }

  return scope;
});

const handlers = {
  memory_append_daily: Effect.fn("memory_append_daily")(function* (input: {
    readonly body: string;
  }) {
    const scope = yield* requireMemoryApp();
    const root = yield* memoryRoot();

    // Attribution is best-effort: an observation with no resolvable project is
    // still worth keeping, so this records "unattributed" rather than failing.
    const project = yield* resolveProjectForThread(scope.threadId).pipe(
      Effect.orElseSucceed(() => null),
    );

    const result = yield* dieOnInfrastructureFailure(
      appendDailyEntry({
        memoryRoot: root,
        body: input.body,
        provenance: {
          capturedAt: DateTime.formatIso(yield* DateTime.now),
          projectSegment: project?.projectSegment ?? null,
          threadId: scope.threadId,
        },
      }),
    );

    return { recorded: true, redactionCount: result.redactions.length };
  }),

  memory_read_daily: Effect.fn("memory_read_daily")(function* () {
    yield* requireMemoryApp();
    const root = yield* memoryRoot();
    return { contents: yield* dieOnInfrastructureFailure(readDaily({ memoryRoot: root })) };
  }),

  memory_search: Effect.fn("memory_search")(function* (input: {
    readonly query?: string | undefined;
    readonly tag?: string | undefined;
    readonly scope?: "global" | "project" | undefined;
    readonly limit?: number | undefined;
  }) {
    const scope = yield* requireMemoryApp();
    const project = yield* resolveProjectForThread(scope.threadId).pipe(
      Effect.orElseSucceed(() => null),
    );

    const filters = {
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(project ? { projectSegment: project.projectSegment } : {}),
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
    };

    // Two different questions, so two different queries. A full-text search
    // ranks by relevance and can say why a note matched; a bare listing ranks by
    // recency. Faking one with the other would give the caller ranking that
    // means nothing.
    if (input.query !== undefined && input.query.trim().length > 0) {
      const rows = yield* dieOnInfrastructureFailure(
        searchNotes({ query: input.query, ...filters }),
      );
      return {
        notes: rows.map((row) => ({
          id: row.id,
          title: row.title,
          scope: row.scope,
          tags: parseTags(row.tags),
          modifiedAt: row.modified_at,
          snippet: row.snippet,
        })),
      };
    }

    const rows = yield* dieOnInfrastructureFailure(
      listNotes({ ...(input.tag === undefined ? {} : { tag: input.tag }), ...filters }),
    );

    return {
      notes: rows.map((row) => ({
        id: row.id,
        title: row.title,
        scope: row.scope,
        tags: parseTags(row.tags),
        modifiedAt: row.modified_at,
      })),
    };
  }),
  drive_write_artifact: Effect.fn("drive_write_artifact")(function* (input: {
    readonly relativePath: string;
    readonly contents: string;
    readonly kind?: string | undefined;
  }) {
    const scope = yield* requireMemoryApp();
    const settings = yield* dieOnInfrastructureFailure((yield* ServerSettingsService).getSettings);
    const config = yield* ServerConfig;
    const driveRoot = resolveDriveRoot(settings, config);

    const project = yield* resolveProjectForThread(scope.threadId).pipe(
      Effect.orElseSucceed(() => null),
    );

    // Unlike capture, a rejected path here is a real failure the model should
    // see: it asked to write a specific file and no file exists afterwards.
    const written = yield* dieOnInfrastructureFailure(
      writeArtifact({
        driveRoot,
        projectSegment: project?.projectSegment ?? null,
        repositoryPath: project?.repositoryPath ?? null,
        relativePath: input.relativePath,
        contents: input.contents,
        kind: input.kind ?? "scratch",
        threadId: scope.threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );

    return {
      id: written.id,
      relativePath: written.relativePath,
      byteSize: written.byteSize,
    };
  }),
} satisfies Parameters<typeof MemoryToolkit.toLayer>[0];

/** Index rows store tags as a JSON array; a corrupt value must not fail a search. */
function parseTags(raw: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

export const MemoryToolkitHandlersLive = MemoryToolkit.toLayer(handlers);
