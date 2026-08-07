/**
 * MemoryRoots - The one way to find out where the vault and drive live.
 *
 * Resolution now has three sources -- the app's own settings file, the
 * deprecated core settings fields, and the `stateDir` default -- and every
 * caller has to agree on their precedence. A handler that consulted only core
 * settings would read a different vault than the indexer writes, which presents
 * as notes that exist on disk and cannot be found.
 *
 * `MemoryPaths` keeps the pure precedence rules so they stay unit-testable; this
 * is the effectful wrapper that gathers the inputs.
 *
 * @module MemoryRoots
 */
import { APP_ID_MEMORY } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { resolveDriveRoot, resolveMemoryRoot } from "./MemoryPaths.ts";
import { readAppSettings } from "../apps/AppSettings.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export interface MemoryRoots {
  readonly memoryRoot: string;
  readonly driveRoot: string;
}

/**
 * Resolve both roots for this server.
 *
 * Settings failures fall back to the derived defaults rather than propagating:
 * an unreadable settings file should mean "no customizations", not "the memory
 * app cannot answer a request".
 */
export const memoryRoots = (): Effect.Effect<
  MemoryRoots,
  never,
  ServerConfig | ServerSettingsService | FileSystem.FileSystem
> => memoryRootsImpl();

const memoryRootsImpl = Effect.fn("memory.roots")(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const settings = yield* Effect.orElseSucceed(settingsService.getSettings, () => null);
  const appSettings = yield* readAppSettings({
    stateDir: config.stateDir,
    appId: APP_ID_MEMORY,
  });

  return {
    memoryRoot: settings ? resolveMemoryRoot(settings, config, appSettings) : config.memoryDir,
    driveRoot: settings ? resolveDriveRoot(settings, config, appSettings) : config.driveDir,
  } satisfies MemoryRoots;
});
