/**
 * Server app registry - what each sidebar app contributes to the server.
 *
 * One declaration per app, replacing the hardcoded wiring each contribution used
 * to need. An app's server-side surface is:
 *
 * - `mcpToolkit`: agent tools, merged into the MCP server for sessions that hold
 *   the app's capability
 * - `hooks`: turn-lifecycle participation (see `AppHooks`)
 *
 * RPC groups will join this list when app RPC gets namespaced; until then the
 * memory methods stay on the core contract.
 *
 * ## Disabling has to remove everything
 *
 * A disabled app contributes no tools and no hooks. Tools especially: leaving
 * them registered would let an agent go on writing to a store the user believes
 * they switched off, which is a worse failure than the rail button lingering.
 * What a disabled app keeps is its data -- "hide it" and "delete my notes" must
 * never be the same button, so nothing here touches an app's directory.
 *
 * @module AppRegistry
 */
import { APP_ID_MEMORY, isAppEnabled } from "@t3tools/contracts";
import type * as Layer from "effect/Layer";

import type { AppTurnHooks } from "./AppHooks.ts";

export interface ServerAppEntry {
  /** Must match the client registry's id for this app. */
  readonly id: string;

  /**
   * Agent tools this app exposes, as a registration layer.
   *
   * Typed loosely on purpose: each toolkit's registration layer has its own
   * output and requirement types, and a union of them is not something the
   * registry can express without naming every app. The layers are built from
   * `McpServer.toolkit(...)` at the call site where those types are known.
   */
  readonly mcpToolkit?: Layer.Layer<never, never, never> | undefined;

  /** Turn-lifecycle hooks. Omitted when an app does not participate in turns. */
  readonly hooks?: AppTurnHooks | undefined;
}

/**
 * Every app the server knows about.
 *
 * Populated by `AppRegistryLive`, which owns the layer construction. Kept as a
 * plain list rather than a service so `enabledApps` filtering is a pure function
 * that can be tested without a runtime.
 */
export interface ServerAppRegistry {
  readonly apps: ReadonlyArray<ServerAppEntry>;
}

/**
 * The subset of registered apps this environment has switched on.
 *
 * An unknown id in `enabledApps` is ignored rather than failing: settings can
 * name an app this build does not ship (a downgrade, or a fork), and refusing to
 * boot over it would make a settings file able to brick a server.
 */
export function resolveEnabledApps(input: {
  readonly registry: ServerAppRegistry;
  readonly enabledApps: ReadonlyArray<string> | undefined;
}): ReadonlyArray<ServerAppEntry> {
  return input.registry.apps.filter((app) =>
    isAppEnabled({ enabledApps: input.enabledApps, appId: app.id }),
  );
}

/** Collect the turn hooks of every enabled app, in registry order. */
export function collectEnabledHooks(input: {
  readonly registry: ServerAppRegistry;
  readonly enabledApps: ReadonlyArray<string> | undefined;
}): ReadonlyArray<{ readonly appId: string; readonly hooks: AppTurnHooks }> {
  return resolveEnabledApps(input).flatMap((app) =>
    app.hooks === undefined ? [] : [{ appId: app.id, hooks: app.hooks }],
  );
}

/** Ids of built-in apps, in the order they appear on the rail. */
export const SERVER_APP_IDS = [APP_ID_MEMORY] as const;
