/**
 * Client app registry - what the shell needs to render a sidebar app.
 *
 * The rail and the app route both read this instead of hardcoding Memory. Adding
 * a built-in app is one entry here plus its component; nothing in the shell
 * changes.
 *
 * Deliberately holds no data-layer concerns. An app's store, settings, RPC, and
 * agent tools are server-side facts declared in the server registry; this side
 * only knows how to put a button on the rail and a component under a route. The
 * `id` is the join between the two.
 *
 * @module apps/registry
 */
import { APP_ID_MEMORY, appWorkspaceRoot, isAppEnabled } from "@t3tools/contracts";
import { BrainIcon, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

import { MemoryView } from "../components/MemoryView";

export interface ClientAppEntry {
  /** Must match the server registry's id for this app. */
  readonly id: string;
  /** Rail tooltip and accessible name. */
  readonly label: string;
  readonly icon: LucideIcon;
  /**
   * Rendered inside the app workspace shell.
   *
   * Apps render without the thread sidebar and bring their own chrome, so a
   * component here owns its full viewport.
   */
  readonly component: ComponentType;
}

/**
 * Every app the client knows how to render.
 *
 * Presence here is not the same as being switched on -- see
 * {@link resolveEnabledApps}. An app stays in this list while disabled so
 * re-enabling it needs no client update.
 */
export const CLIENT_APPS: ReadonlyArray<ClientAppEntry> = [
  { id: APP_ID_MEMORY, label: "Memory", icon: BrainIcon, component: MemoryView },
];

export function findClientApp(appId: string | null): ClientAppEntry | null {
  if (appId === null) {
    return null;
  }
  return CLIENT_APPS.find((app) => app.id === appId) ?? null;
}

/**
 * The apps this environment has switched on, in registry order.
 *
 * Registry order rather than `enabledApps` order so the rail does not reshuffle
 * when a user toggles one off and on again. An id in `enabledApps` with no
 * client entry is skipped rather than erroring: a newer environment may know
 * about an app this client build does not, and a mystery rail button that
 * renders nothing is worse than a missing one.
 */
export function resolveEnabledApps(
  enabledApps: ReadonlyArray<string> | undefined,
): ReadonlyArray<ClientAppEntry> {
  return CLIENT_APPS.filter((app) => isAppEnabled({ enabledApps, appId: app.id }));
}

/** Canonical route for an app's workspace root. */
export function clientAppHref(app: ClientAppEntry): string {
  return appWorkspaceRoot(app.id);
}
