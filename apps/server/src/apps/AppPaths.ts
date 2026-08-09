/**
 * AppPaths - Where a sidebar app's own state lives.
 *
 * Every app owns one directory, `<stateDir>/apps/<appId>/`, and everything it
 * persists goes inside it: its SQLite index, its settings, and whatever files it
 * treats as authoritative. Two consequences are the reason for the layout:
 *
 * - "uninstall this app" is a directory delete, with no rows to hunt down in a
 *   shared database
 * - a broken app cannot corrupt thread state, because it has no write access to
 *   anything above its own directory
 *
 * App ids are validated rather than sanitized. An id is a developer-supplied
 * registry key (or, later, a manifest field), so a bad one is a bug or an
 * attack; rewriting it into something valid would hide both and could silently
 * point two apps at one directory.
 *
 * @module AppPaths
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

/** Directory under `stateDir` holding every app's data directory. */
export const APPS_DIRNAME = "apps";

/** Filename of an app's SQLite index, inside its data directory. */
export const APP_DATABASE_FILENAME = "state.sqlite";

/** Filename of an app's own settings, inside its data directory. */
export const APP_SETTINGS_FILENAME = "settings.json";

/**
 * Lowercase, dash-separated, no dots or separators.
 *
 * Excluding `.` is what makes traversal impossible without a second check: no
 * accepted id can contain `..`, so no accepted id can escape the apps directory.
 */
const APP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest id we accept, so the full path stays inside filesystem limits. */
const APP_ID_MAX_CHARS = 48;

export function isValidAppId(appId: string): boolean {
  return appId.length > 0 && appId.length <= APP_ID_MAX_CHARS && APP_ID_PATTERN.test(appId);
}

export interface ResolvedAppPaths {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly settingsPath: string;
}

/**
 * Resolve an app's directories, or `null` when the id is not one we accept.
 *
 * Null rather than a thrown error or a corrected id: callers differ on whether
 * an unknown app is a failure (a request naming a missing app) or a skip
 * (iterating a registry that has drifted), and only the caller knows which.
 */
export function resolveAppPaths(input: {
  readonly stateDir: string;
  readonly appId: string;
}): ResolvedAppPaths | null {
  if (!isValidAppId(input.appId)) {
    return null;
  }

  const dataDirectory = NodePath.join(input.stateDir, APPS_DIRNAME, input.appId);
  return {
    dataDirectory,
    databasePath: NodePath.join(dataDirectory, APP_DATABASE_FILENAME),
    settingsPath: NodePath.join(dataDirectory, APP_SETTINGS_FILENAME),
  };
}
