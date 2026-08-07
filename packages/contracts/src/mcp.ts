/**
 * MCP capability contracts.
 *
 * `PreviewAutomationUnavailableError` predates this module and is specific to
 * the preview toolkit, both in name and in its `capability: "preview"` literal.
 * Capabilities beyond preview use the generalized error here so a memory tool
 * denial does not surface as a preview error.
 *
 * @module mcp
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Capabilities an MCP credential can carry.
 *
 * Keep this in sync with `McpCapability` on the server: the server type is the
 * one `requireMcpCapability` checks, this is the one that crosses the wire in
 * errors.
 */
export const McpCapabilityName = Schema.Literals(["preview", "memory", "thread"]);
export type McpCapabilityName = typeof McpCapabilityName.Type;

/** Raised when a session's credential does not grant the capability a tool needs. */
export class McpCapabilityUnavailableError extends Schema.TaggedErrorClass<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: McpCapabilityName,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: TrimmedNonEmptyString,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}
