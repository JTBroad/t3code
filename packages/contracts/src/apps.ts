/**
 * Sidebar app identity, shared by server and clients.
 *
 * A sidebar app is a self-contained workspace hanging off the workspace rail:
 * its own data store, its own settings, its own RPC namespace, its own agent
 * tools. Memory is the first; scheduled prompts are next; user-authored pages
 * come later through the same registry.
 *
 * Only the *vocabulary* lives here -- ids, the route prefix, and which apps ship
 * built in. The registries themselves are per-side, because the two sides hold
 * genuinely different things: the server registry carries RPC groups, turn
 * hooks, and MCP toolkits, and the client registry carries labels, icons, and
 * React components. Forcing one shape onto both would mean each side declaring
 * fields it has no use for.
 *
 * @module apps
 */

/**
 * Built-in app ids.
 *
 * Ids must satisfy the server's `isValidAppId`: lowercase, dash-separated, no
 * dots or separators. That is what makes an id safe to use as a directory name
 * under `<stateDir>/apps/`.
 */
export const APP_ID_MEMORY = "memory";

/** Every app that ships with the product. */
export const BUILT_IN_APP_IDS = [APP_ID_MEMORY] as const;

export type BuiltInAppId = (typeof BUILT_IN_APP_IDS)[number];

/**
 * Apps switched on for a fresh install, and the fallback when a settings file
 * predates `enabledApps`.
 *
 * Every built-in, deliberately: this field arrived after Memory shipped, so a
 * default of "none" would silently remove a workspace someone is already using.
 */
export const DEFAULT_ENABLED_APPS: ReadonlyArray<string> = BUILT_IN_APP_IDS;

/**
 * Route prefix every app workspace mounts under.
 *
 * One prefix rather than a per-app top-level path is what lets the shell answer
 * "is the user inside an app right now?" without consulting the registry, which
 * matters because that question is asked on every render of the root layout.
 */
export const APP_ROUTE_PREFIX = "/apps";

/** Canonical root route for an app workspace. */
export function appWorkspaceRoot(appId: string): string {
  return `${APP_ROUTE_PREFIX}/${appId}`;
}

/**
 * Whether a pathname is inside any app workspace.
 *
 * Prefix-based and registry-free on purpose -- see {@link APP_ROUTE_PREFIX}. A
 * path naming an app that does not exist still counts as "inside an app": the
 * route layer is what turns an unknown app into a redirect, and treating it as a
 * thread route first would flash the wrong shell before that happened.
 */
export function isAppWorkspacePath(pathname: string): boolean {
  return pathname === APP_ROUTE_PREFIX || pathname.startsWith(`${APP_ROUTE_PREFIX}/`);
}

/** Extract the app id from a path inside {@link APP_ROUTE_PREFIX}, if any. */
export function appIdFromPath(pathname: string): string | null {
  if (!isAppWorkspacePath(pathname)) {
    return null;
  }
  const remainder = pathname.slice(APP_ROUTE_PREFIX.length).replace(/^\//, "");
  const [appId = ""] = remainder.split("/");
  return appId.length === 0 ? null : appId;
}

/** Whether an app is switched on, tolerating a settings file with no list. */
export function isAppEnabled(input: {
  readonly enabledApps: ReadonlyArray<string> | undefined;
  readonly appId: string;
}): boolean {
  return (input.enabledApps ?? DEFAULT_ENABLED_APPS).includes(input.appId);
}
