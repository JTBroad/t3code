/**
 * CopilotAdapter — ProviderAdapter implementation backed by
 * `@github/copilot-sdk`.
 *
 * Phase 1 skeleton: the adapter compiles, registers, and emits nothing.
 * Every session operation fails with a typed "not implemented" error.
 * Phases 3–5 replace the stubs with the real SDK-backed runtime (see
 * `.plans/21-copilot-adapter.md`).
 *
 * @module provider/Layers/CopilotAdapter
 */
import {
  type CopilotSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("copilot");

export interface CopilotAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const notImplemented = (method: string) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: `Copilot adapter: ${method} is not implemented yet.`,
    }),
  );

export function makeCopilotAdapter(
  _copilotSettings: CopilotSettings,
  _options?: CopilotAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Effect.addFinalizer(() => Queue.shutdown(runtimeEvents));

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
      },
      startSession: () => notImplemented("startSession"),
      sendTurn: () => notImplemented("sendTurn"),
      interruptTurn: () => notImplemented("interruptTurn"),
      respondToRequest: () => notImplemented("respondToRequest"),
      respondToUserInput: () => notImplemented("respondToUserInput"),
      stopSession: () => notImplemented("stopSession"),
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      readThread: (threadId) => notImplemented(`readThread(${threadId})`),
      rollbackThread: (threadId) => notImplemented(`rollbackThread(${threadId})`),
      stopAll: () => Effect.void,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies CopilotAdapterShape;
  });
}
