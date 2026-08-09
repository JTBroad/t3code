/**
 * AppsRpc - Server handlers for listing, installing, and removing user apps.
 *
 * Install reads a drive artifact and copies it into the app's directory. The
 * copy is the point: the drive is written by a tool the model can call on any
 * turn, so scanning it for apps would let an agent install UI with no user
 * action. Going through an RPC the client calls means installing is something a
 * person did.
 *
 * @module AppsRpc
 */
import {
  AppOperationError,
  type AppsInstallFromArtifactResult,
  type AppsListResult,
  type AppsUninstallResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  installPageApp,
  isInstallableArtifactPath,
  listInstalledApps,
  toAppId,
  uninstallApp,
} from "./AppInstaller.ts";
import { ServerConfig } from "../config.ts";
import { getArtifact } from "../memory/ArtifactStore.ts";
import { memoryRoots } from "../memory/MemoryRoots.ts";
import { resolveWithinRoot } from "../memory/MemoryPaths.ts";

const failed = (operation: string, message: string) =>
  Effect.fail(new AppOperationError({ operation, message }));

export const appsList = Effect.fn("apps.rpc.list")(function* () {
  const config = yield* ServerConfig;
  const apps = yield* Effect.orElseSucceed(
    listInstalledApps({ stateDir: config.stateDir }),
    () => [],
  );
  return { apps } satisfies AppsListResult;
});

/**
 * Install an HTML drive artifact as a sidebar app.
 *
 * The user supplies the name, which becomes both the rail label and the app id.
 * Deliberately not taken from the artifact or chosen by the model: the rail is
 * the user's own navigation, and an app that could name itself could impersonate
 * a built-in.
 */
export const appsInstallFromArtifact = Effect.fn("apps.rpc.installFromArtifact")(function* (input: {
  readonly artifactId: string;
  readonly name: string;
  readonly icon?: string | undefined;
}) {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const appId = toAppId(input.name);
  if (appId === null) {
    return yield* failed("apps.install", "That name cannot be used as an app id.");
  }

  const record = yield* Effect.orElseSucceed(getArtifact(input.artifactId), () => null);
  if (record === null) {
    return yield* failed("apps.install", "That artifact no longer exists.");
  }

  // HTML only, checked against the recorded path. Without this, "install" could
  // be pointed at any file the drive happens to hold.
  if (!isInstallableArtifactPath(record.relative_path)) {
    return yield* failed("apps.install", "Only HTML files can be installed as apps.");
  }

  const { driveRoot } = yield* memoryRoots();
  const absolutePath = resolveWithinRoot({ root: driveRoot, relativePath: record.relative_path });
  if (!absolutePath || !(yield* Effect.orElseSucceed(fs.exists(absolutePath), () => false))) {
    return yield* failed("apps.install", "That artifact's file is missing.");
  }

  const contents = yield* Effect.orElseSucceed(fs.readFileString(absolutePath), () => null);
  if (contents === null) {
    return yield* failed("apps.install", "That artifact could not be read.");
  }

  const app = yield* Effect.orElseSucceed(
    installPageApp({
      stateDir: config.stateDir,
      appId,
      name: input.name,
      ...(input.icon === undefined ? {} : { icon: input.icon }),
      contents,
      source: {
        artifactId: record.id,
        ...(record.thread_id === null ? {} : { threadId: record.thread_id }),
      },
    }),
    () => null,
  );

  if (app === null) {
    return yield* failed("apps.install", "The app could not be written to disk.");
  }

  yield* Effect.logInfo("installed a user app", {
    appId: app.id,
    artifactId: record.id,
    entry: path.basename(absolutePath),
  });

  return { app } satisfies AppsInstallFromArtifactResult;
});

export const appsUninstall = Effect.fn("apps.rpc.uninstall")(function* (input: {
  readonly appId: string;
}) {
  const config = yield* ServerConfig;
  const removed = yield* Effect.orElseSucceed(
    uninstallApp({ stateDir: config.stateDir, appId: input.appId }),
    () => false,
  );
  return { removed } satisfies AppsUninstallResult;
});
