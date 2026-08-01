import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

const scope = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

// A memory denial must not surface as a preview error: the toolkit names are
// user-visible in logs and the two have nothing to do with each other.
it.effect("reports a generalized error when the memory capability is unavailable", () =>
  Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("memory").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope(new Set(["preview"]))),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "memory", threadId: ThreadId.make("thread-1") });
    expect(error.message).toBe("MCP credential does not grant the memory capability.");
  }),
);

it.effect("returns the invocation when the capability is granted", () =>
  Effect.gen(function* () {
    const granted = scope(new Set(["preview", "memory"]));
    const invocation = yield* McpInvocationContext.requireMcpCapability("memory").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, granted),
    );

    expect(invocation.threadId).toBe(granted.threadId);
  }),
);
