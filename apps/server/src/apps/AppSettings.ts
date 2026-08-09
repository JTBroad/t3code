/**
 * AppSettings - Per-app settings, stored beside the app's data.
 *
 * `memoryRootDirectory` and `driveRootDirectory` used to live in the shared
 * `ServerSettings` schema. That is the same fork-versus-upstream collision class
 * as a fork-local table in the shared migration sequence, only for settings: every
 * app field added to the core schema is a future merge conflict, and an app that
 * is disabled or absent still carries its fields there forever.
 *
 * So an app's settings live in `<stateDir>/apps/<appId>/settings.json`, and the
 * only app-related field left in core settings is `enabledApps` -- the bootstrap
 * that decides which apps load, which by definition cannot live inside an app.
 *
 * Values already in core settings are imported on first read and continue to be
 * honoured as a fallback: someone who set a custom memory root before this change
 * must not silently get the default one, and their notes must not appear to
 * vanish.
 *
 * @module AppSettings
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";

import { resolveAppPaths } from "./AppPaths.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

/**
 * An app's settings document.
 *
 * Free-form on purpose: only the app knows its own keys, and a core-side schema
 * listing them would put us straight back into the shared-schema collision this
 * whole move exists to escape.
 */
export type AppSettingsDocument = Record<string, unknown>;

const AppSettingsSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeAppSettings = Schema.decodeUnknownEffect(fromLenientJson(AppSettingsSchema));
const encodeAppSettings = Schema.encodeUnknownEffect(fromJsonStringPretty(AppSettingsSchema));

/**
 * Read an app's settings file.
 *
 * Returns an empty document when the file is absent or unreadable rather than
 * failing. Settings are a customization layer; an unparseable file should mean
 * "no customizations" and leave the app working on defaults, not stop it loading.
 */
export const readAppSettings = Effect.fn("apps.readSettings")(function* (input: {
  readonly stateDir: string;
  readonly appId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const paths = resolveAppPaths({ stateDir: input.stateDir, appId: input.appId });
  if (paths === null) {
    return {} as AppSettingsDocument;
  }

  const exists = yield* Effect.orElseSucceed(fs.exists(paths.settingsPath), () => false);
  if (!exists) {
    return {} as AppSettingsDocument;
  }

  const contents = yield* Effect.orElseSucceed(fs.readFileString(paths.settingsPath), () => "");
  return yield* Effect.orElseSucceed(
    decodeAppSettings(contents),
    () => ({}) as AppSettingsDocument,
  );
});

/** Merge keys into an app's settings file, creating it if needed. */
export const updateAppSettings = Effect.fn("apps.updateSettings")(function* (input: {
  readonly stateDir: string;
  readonly appId: string;
  readonly patch: AppSettingsDocument;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = resolveAppPaths({ stateDir: input.stateDir, appId: input.appId });
  if (paths === null) {
    return {} as AppSettingsDocument;
  }

  const current = yield* readAppSettings({ stateDir: input.stateDir, appId: input.appId });
  const next = { ...current, ...input.patch };

  yield* fs.makeDirectory(path.dirname(paths.settingsPath), { recursive: true });
  yield* writeFileStringAtomically({
    filePath: paths.settingsPath,
    contents: `${yield* Effect.orDie(encodeAppSettings(next))}\n`,
  });
  return next;
});

/**
 * Read a string setting, preferring the app's own file and falling back to a
 * value inherited from core settings.
 *
 * The fallback is what keeps an existing custom root working without a migration
 * step that could fail halfway. It is deliberately not written through to the app
 * file on read: a read path that writes is a surprising thing to debug, and the
 * fallback costs nothing to keep honouring.
 */
export function resolveAppStringSetting(input: {
  readonly appSettings: AppSettingsDocument;
  readonly key: string;
  readonly inheritedValue: string;
}): string {
  const own = input.appSettings[input.key];
  if (typeof own === "string" && own.trim().length > 0) {
    return own.trim();
  }
  return input.inheritedValue;
}
