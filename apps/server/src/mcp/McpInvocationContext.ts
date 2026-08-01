import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Capabilities an MCP session can be granted. Mirrors `McpCapabilityName` in
 * contracts, which is the shape that crosses the wire in errors.
 */
export type McpCapability = "preview" | "memory";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

const requireMcpCapabilityImpl = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    const denial = {
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    };
    // Preview keeps its original error so existing clients decoding
    // PreviewAutomationUnavailableError are unaffected; anything else gets the
    // generalized one rather than an error named after a toolkit it never used.
    return yield* capability === "preview"
      ? new PreviewAutomationUnavailableError({ capability, ...denial })
      : new McpCapabilityUnavailableError({ capability, ...denial });
  }
  return invocation;
});

/**
 * Require a capability, failing with the error that belongs to it.
 *
 * The implementation handles every capability, so its inferred failure type is
 * the union of both errors. Callers only ever pass one literal, and a preview
 * handler should not have to declare a memory error it can never receive --
 * hence the overloads narrowing the failure per capability.
 */
export const requireMcpCapability = requireMcpCapabilityImpl as {
  (
    capability: "preview",
  ): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
  (
    capability: Exclude<McpCapability, "preview">,
  ): Effect.Effect<McpInvocationScope, McpCapabilityUnavailableError, McpInvocationContext>;
};
