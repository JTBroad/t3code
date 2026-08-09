/**
 * AppInstaller - Discovering, installing, and removing user-authored apps.
 *
 * A user app is a directory under `<stateDir>/apps/` holding a manifest and a
 * self-contained HTML page. Built-in apps are React components compiled into the
 * client; these are files on disk, discovered at runtime, which is what lets
 * someone add one without rebuilding the product.
 *
 * ## Installing is a user action, never a tool call
 *
 * This is the load-bearing rule. `drive_write_artifact` is a tool the model can
 * call on any turn, and it takes an arbitrary path and arbitrary contents. If
 * the app loader scanned the drive, any agent turn could install a sidebar app --
 * new UI, and eventually new host access -- with nothing on screen and no
 * approval. So the drive is where an app is *authored* and this directory is
 * where it *runs*, and crossing between them is an explicit user-initiated copy.
 *
 * That also gives the flow its provenance for free: the artifact records which
 * thread and turn produced the page, and the manifest records which artifact it
 * was installed from.
 *
 * ## A bad app must not break the rail
 *
 * Every read here is defensive. An unparseable manifest, a missing entry file, a
 * directory that is not an app at all -- each is skipped with a log, never
 * fatal. One malformed folder must not take the workspace rail down with it.
 *
 * @module AppInstaller
 */
import {
  APP_MANIFEST_FILENAME,
  AppManifest,
  appEntryUrl,
  isInstallableArtifactPath,
  type InstalledApp,
} from "@t3tools/contracts";

export { isInstallableArtifactPath };
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { fromLenientJson } from "@t3tools/shared/schemaJson";

import { APPS_DIRNAME, isValidAppId, resolveAppPaths } from "./AppPaths.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

const decodeManifest = Schema.decodeUnknownEffect(fromLenientJson(AppManifest));
const encodeManifest = Schema.encodeUnknownEffect(Schema.fromJsonString(AppManifest));

/**
 * Derive an app id from a name.
 *
 * The user supplies a display name; the id is what becomes a directory, so it
 * has to satisfy `isValidAppId`. Returns null rather than a mangled fallback --
 * an unusable name should be reported, not silently turned into `app-1`.
 */
export function toAppId(name: string): string | null {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return isValidAppId(id) ? id : null;
}

/** Read and validate one app directory. Returns null when it is not an app. */
export const readInstalledApp = Effect.fn("apps.readInstalled")(function* (input: {
  readonly stateDir: string;
  readonly appId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = resolveAppPaths({ stateDir: input.stateDir, appId: input.appId });
  if (paths === null) {
    return null;
  }

  const manifestPath = path.join(paths.dataDirectory, APP_MANIFEST_FILENAME);
  if (!(yield* Effect.orElseSucceed(fs.exists(manifestPath), () => false))) {
    // A built-in app's directory holds a store and settings but no manifest.
    // Not an error -- just not a user app.
    return null;
  }

  const contents = yield* Effect.orElseSucceed(fs.readFileString(manifestPath), () => "");
  const manifest = yield* Effect.orElseSucceed(decodeManifest(contents), () => null);
  if (manifest === null) {
    yield* Effect.logWarning("app manifest could not be read", { appId: input.appId });
    return null;
  }

  // The id is what addresses the app everywhere else, so a manifest claiming a
  // different id than its directory would make routes and settings disagree.
  if (manifest.id !== input.appId) {
    yield* Effect.logWarning("app manifest id does not match its directory", {
      appId: input.appId,
      manifestId: manifest.id,
    });
    return null;
  }

  // An entry that escapes the app directory would turn the asset route into an
  // arbitrary file read. Refused rather than clamped: a manifest that asks for
  // it is a bug or an attack, and correcting it hides both.
  const entryPath = path.join(paths.dataDirectory, manifest.entry);
  const resolvedRoot = path.resolve(paths.dataDirectory);
  if (!path.resolve(entryPath).startsWith(`${resolvedRoot}${path.sep}`)) {
    yield* Effect.logWarning("app entry escapes its directory", { appId: input.appId });
    return null;
  }

  if (!(yield* Effect.orElseSucceed(fs.exists(entryPath), () => false))) {
    yield* Effect.logWarning("app entry file is missing", { appId: input.appId });
    return null;
  }

  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
    kind: "page" as const,
    entryUrl: appEntryUrl({ appId: manifest.id, entry: manifest.entry }),
    ...(manifest.source === undefined ? {} : { source: manifest.source }),
  } satisfies InstalledApp;
});

/** Every user app installed in this environment, by directory order. */
export const listInstalledApps = Effect.fn("apps.listInstalled")(function* (input: {
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appsRoot = path.join(input.stateDir, APPS_DIRNAME);

  if (!(yield* Effect.orElseSucceed(fs.exists(appsRoot), () => false))) {
    return [] as ReadonlyArray<InstalledApp>;
  }

  const entries = yield* Effect.orElseSucceed(fs.readDirectory(appsRoot), () => [] as string[]);
  const apps: Array<InstalledApp> = [];
  for (const entry of entries) {
    const app = yield* readInstalledApp({ stateDir: input.stateDir, appId: entry });
    if (app !== null) {
      apps.push(app);
    }
  }
  return apps as ReadonlyArray<InstalledApp>;
});

export interface InstallFromFileInput {
  readonly stateDir: string;
  readonly appId: string;
  readonly name: string;
  readonly icon?: string | undefined;
  readonly contents: string;
  readonly source?:
    | {
        readonly artifactId?: string | undefined;
        readonly threadId?: string | undefined;
      }
    | undefined;
}

/**
 * Install a page as an app.
 *
 * Writes the page and a manifest into the app's directory. Overwrites an
 * existing app of the same id on purpose: re-installing is how an app is
 * updated, and the alternative -- refusing, or minting `foo-2` -- turns "the
 * agent made me a new version" into a directory full of near-duplicates.
 */
export const installPageApp = Effect.fn("apps.installPage")(function* (
  input: InstallFromFileInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = resolveAppPaths({ stateDir: input.stateDir, appId: input.appId });
  if (paths === null) {
    return null;
  }

  const entry = "index.html";
  const manifest: AppManifest = {
    id: input.appId,
    name: input.name,
    entry,
    ...(input.icon === undefined ? {} : { icon: input.icon }),
    source: {
      ...(input.source?.artifactId === undefined ? {} : { artifactId: input.source.artifactId }),
      ...(input.source?.threadId === undefined ? {} : { threadId: input.source.threadId }),
      installedAt: DateTime.formatIso(yield* DateTime.now),
    },
  };

  yield* fs.makeDirectory(paths.dataDirectory, { recursive: true });
  yield* writeFileStringAtomically({
    filePath: path.join(paths.dataDirectory, entry),
    contents: input.contents,
  });
  yield* writeFileStringAtomically({
    filePath: path.join(paths.dataDirectory, APP_MANIFEST_FILENAME),
    contents: `${yield* Effect.orDie(encodeManifest(manifest))}\n`,
  });

  return {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
    kind: "page" as const,
    entryUrl: appEntryUrl({ appId: manifest.id, entry }),
    ...(manifest.source === undefined ? {} : { source: manifest.source }),
  } satisfies InstalledApp;
});

/**
 * Remove an installed user app, directory and all.
 *
 * Only removes directories that read back as a user app, so a bug in a caller
 * cannot delete a built-in's store -- and "uninstall" for a built-in is a toggle
 * anyway, which never touches data.
 */
export const uninstallApp = Effect.fn("apps.uninstall")(function* (input: {
  readonly stateDir: string;
  readonly appId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const paths = resolveAppPaths({ stateDir: input.stateDir, appId: input.appId });
  if (paths === null) {
    return false;
  }

  const app = yield* readInstalledApp({ stateDir: input.stateDir, appId: input.appId });
  if (app === null) {
    return false;
  }

  yield* Effect.orElseSucceed(fs.remove(paths.dataDirectory, { recursive: true }), () => undefined);
  return true;
});
