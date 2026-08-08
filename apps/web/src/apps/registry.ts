/**
 * Client app registry - what the shell needs to render a sidebar app.
 *
 * Two populations, one list. Built-ins are React components compiled into the
 * bundle; user apps are HTML pages discovered on the server at runtime and
 * rendered in a sandboxed iframe. The rail and the app route consume the merged
 * list and do not care which kind an entry is.
 *
 * That split is the whole point of the runtime half: a user cannot rebuild the
 * web bundle, the desktop app, or the mobile binary, so a user app can never be a
 * compiled component.
 *
 * Deliberately holds no data-layer concerns. An app's store, settings, RPC, and
 * agent tools are server-side facts; this side only knows how to put a button on
 * the rail and something under a route. The `id` is the join between the two.
 *
 * @module apps/registry
 */
import {
  APP_ID_MEMORY,
  appWorkspaceRoot,
  isAppEnabled,
  type InstalledApp,
} from "@t3tools/contracts";
import { BrainIcon, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

import { MemoryView } from "../components/MemoryView";

export interface ClientAppEntry {
  /** Must match the server registry's id for this app. */
  readonly id: string;
  /** Rail tooltip and accessible name. */
  readonly label: string;
  /** Built-ins ship an icon component; user apps supply an emoji, or neither. */
  readonly icon?: LucideIcon | undefined;
  readonly emoji?: string | undefined;
  readonly kind: "builtin" | "page";
  /**
   * Rendered inside the app workspace shell.
   *
   * Apps render without the thread sidebar and bring their own chrome, so a
   * component here owns its full viewport.
   */
  readonly component?: ComponentType | undefined;
  /** The installed record, for page apps. Carries the URL and its provenance. */
  readonly installed?: InstalledApp | undefined;
}

/**
 * Apps compiled into this client build.
 *
 * Presence here is not the same as being switched on -- see
 * {@link resolveEnabledApps}. An app stays in this list while disabled so
 * re-enabling it needs no client update.
 */
export const BUILT_IN_APPS: ReadonlyArray<ClientAppEntry> = [
  { id: APP_ID_MEMORY, label: "Memory", icon: BrainIcon, kind: "builtin", component: MemoryView },
];

/** @deprecated Use {@link BUILT_IN_APPS}; kept so existing imports still read. */
export const CLIENT_APPS = BUILT_IN_APPS;

/** Turn a server-discovered app into a registry entry. */
export function toClientAppEntry(installed: InstalledApp): ClientAppEntry {
  return {
    id: installed.id,
    label: installed.name,
    ...(installed.icon === undefined ? {} : { emoji: installed.icon }),
    kind: "page",
    installed,
  };
}

/**
 * Every app this client can render, built-ins first.
 *
 * Built-ins first so a user app cannot displace Memory from the top of the rail
 * by naming itself cleverly. An installed app whose id collides with a built-in
 * is dropped rather than merged: two entries with one id would make the route
 * lookup order-dependent, and a page app shadowing a built-in is the more
 * dangerous direction to resolve it in.
 */
export function mergeApps(
  installed: ReadonlyArray<InstalledApp> | undefined,
): ReadonlyArray<ClientAppEntry> {
  const builtInIds = new Set(BUILT_IN_APPS.map((app) => app.id));
  const seen = new Set(builtInIds);
  const userApps: Array<ClientAppEntry> = [];

  for (const app of installed ?? []) {
    if (seen.has(app.id)) {
      continue;
    }
    seen.add(app.id);
    userApps.push(toClientAppEntry(app));
  }

  return [...BUILT_IN_APPS, ...userApps];
}

export function findClientApp(
  appId: string | null,
  apps: ReadonlyArray<ClientAppEntry> = BUILT_IN_APPS,
): ClientAppEntry | null {
  if (appId === null) {
    return null;
  }
  return apps.find((app) => app.id === appId) ?? null;
}

/**
 * The apps this environment has switched on, in registry order.
 *
 * Registry order rather than `enabledApps` order so the rail does not reshuffle
 * when a user toggles one off and on again.
 *
 * User apps default to enabled: `enabledApps` only lists built-ins, and a
 * freshly installed app that did not appear until you also flipped a switch
 * would read as a failed install. Installing *is* the opt-in.
 */
export function resolveEnabledApps(
  enabledApps: ReadonlyArray<string> | undefined,
  apps: ReadonlyArray<ClientAppEntry> = BUILT_IN_APPS,
): ReadonlyArray<ClientAppEntry> {
  return apps.filter((app) => app.kind === "page" || isAppEnabled({ enabledApps, appId: app.id }));
}

/** Canonical route for an app's workspace root. */
export function clientAppHref(app: ClientAppEntry): string {
  return appWorkspaceRoot(app.id);
}
