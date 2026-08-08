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
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/* ── user-authored apps ─────────────────────────────────────────────────── */

/** Filename of a user app's manifest, inside its app directory. */
export const APP_MANIFEST_FILENAME = "manifest.json";

/** Route prefix that serves an installed user app's own files. */
export const APP_ASSET_ROUTE_PREFIX = "/app-assets";

/**
 * How an app's UI is delivered.
 *
 * `builtin` apps are React components compiled into the client; `page` apps are
 * a self-contained HTML file served from disk and rendered in a sandboxed
 * iframe. The distinction is not cosmetic -- a page app is untrusted code from a
 * file on disk, and everything about how it is loaded follows from that.
 */
export const AppKind = Schema.Literals(["builtin", "page"]);
export type AppKind = typeof AppKind.Type;

/**
 * A user app's manifest.
 *
 * Deliberately small. Everything here is either needed to put a button on the
 * rail or needed to load the page safely; anything else is a field we would have
 * to keep honouring once manifests exist on users' disks.
 */
export const AppManifest = Schema.Struct({
  /** Must match the directory name, and satisfy the server's id rules. */
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  /** Rail tooltip and accessible name. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** File inside the app directory to load, e.g. `index.html`. */
  entry: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /**
   * Emoji shown on the rail.
   *
   * An emoji rather than an image path: an app-supplied image is another file to
   * serve and another way to make the rail look like something it is not.
   */
  icon: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8))),
  /**
   * The host API version this app was written against.
   *
   * Recorded now so the first app that actually calls the host is not also the
   * thing that has to introduce versioning. Nothing enforces it yet, because
   * page apps currently get no host access at all.
   */
  hostApiVersion: Schema.optionalKey(Schema.Int),
  /** Where this app came from, when it was installed from a drive artifact. */
  source: Schema.optionalKey(
    Schema.Struct({
      artifactId: Schema.optionalKey(TrimmedNonEmptyString),
      threadId: Schema.optionalKey(TrimmedNonEmptyString),
      installedAt: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type AppManifest = typeof AppManifest.Type;

/** An installed user app as the client needs to render it. */
export const InstalledApp = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  icon: Schema.optionalKey(TrimmedNonEmptyString),
  kind: AppKind,
  /** URL the client loads into the iframe. */
  entryUrl: TrimmedNonEmptyString,
  source: Schema.optionalKey(
    Schema.Struct({
      artifactId: Schema.optionalKey(TrimmedNonEmptyString),
      threadId: Schema.optionalKey(TrimmedNonEmptyString),
      installedAt: Schema.optionalKey(TrimmedNonEmptyString),
    }),
  ),
});
export type InstalledApp = typeof InstalledApp.Type;

/** The URL that serves a user app's entry file. */
export function appEntryUrl(input: { readonly appId: string; readonly entry: string }): string {
  return `${APP_ASSET_ROUTE_PREFIX}/${input.appId}/${input.entry}`;
}

/**
 * Extensions a page app may be installed from.
 *
 * HTML only, and matched against the artifact's recorded path rather than its
 * contents. Broad enough for what agents actually produce, narrow enough that
 * "install this" cannot be pointed at an arbitrary file in the drive.
 *
 * Shared so the client and the server agree: an install button that appears and
 * then fails on the server is worse than no button.
 */
const INSTALLABLE_EXTENSIONS = [".html", ".htm"];

export function isInstallableArtifactPath(relativePath: string): boolean {
  const lowered = relativePath.toLowerCase();
  return INSTALLABLE_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/* ── rpc payloads ───────────────────────────────────────────────────────── */

export const AppsListInput = Schema.Struct({});
export const AppsListResult = Schema.Struct({ apps: Schema.Array(InstalledApp) });
export type AppsListResult = typeof AppsListResult.Type;

export const AppsInstallFromArtifactInput = Schema.Struct({
  artifactId: TrimmedNonEmptyString,
  /** Rail label. The user names it, not the model. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  icon: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(8))),
});
export const AppsInstallFromArtifactResult = Schema.Struct({ app: InstalledApp });
export type AppsInstallFromArtifactResult = typeof AppsInstallFromArtifactResult.Type;

export const AppsUninstallInput = Schema.Struct({ appId: TrimmedNonEmptyString });
export const AppsUninstallResult = Schema.Struct({ removed: Schema.Boolean });
export type AppsUninstallResult = typeof AppsUninstallResult.Type;

export class AppOperationError extends Schema.ErrorClass<AppOperationError>("AppOperationError")({
  _tag: Schema.tag("AppOperationError"),
  operation: Schema.String,
  message: Schema.String,
}) {}

/* ── rpc methods ────────────────────────────────────────────────────────── */

/**
 * The app-management surface.
 *
 * Namespaced under `apps.*` rather than `app.<id>.*`: these are operations on
 * the set of installed apps, not operations belonging to any one of them.
 */
export const APPS_METHODS = {
  list: "apps.list",
  installFromArtifact: "apps.installFromArtifact",
  uninstall: "apps.uninstall",
} as const;
