import * as NodeServices from "@effect/platform-node/NodeServices";
import { APP_MANIFEST_FILENAME } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  installPageApp,
  isInstallableArtifactPath,
  listInstalledApps,
  readInstalledApp,
  toAppId,
  uninstallApp,
} from "./AppInstaller.ts";

const layer = it.layer(NodeServices.layer);

const stateDir = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-apps-" });
});

describe("toAppId", () => {
  it("turns a display name into a directory-safe id", () => {
    expect(toAppId("Fall Foliage Map")).toBe("fall-foliage-map");
    expect(toAppId("  Weather!  ")).toBe("weather");
  });

  // Null rather than a mangled fallback: an unusable name should be reported,
  // not silently turned into something the user did not ask for.
  it("returns null when nothing usable is left", () => {
    expect(toAppId("!!!")).toBeNull();
    expect(toAppId("")).toBeNull();
  });

  // The id becomes a directory name under the state dir, so a name that
  // sanitized into traversal would be a path escape.
  it("cannot produce a traversal", () => {
    expect(toAppId("../../etc")).toBe("etc");
    expect(toAppId("..")).toBeNull();
  });
});

describe("isInstallableArtifactPath", () => {
  it("accepts HTML only", () => {
    expect(isInstallableArtifactPath("out/map.html")).toBe(true);
    expect(isInstallableArtifactPath("MAP.HTM")).toBe(true);
    expect(isInstallableArtifactPath("notes.md")).toBe(false);
    expect(isInstallableArtifactPath("script.js")).toBe(false);
    // Not fooled by an extension appearing mid-path.
    expect(isInstallableArtifactPath("html/report.md")).toBe(false);
  });
});

layer("install and discovery", (it) => {
  it.effect("installs a page and reads it back", () =>
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const installed = yield* installPageApp({
        stateDir: dir,
        appId: "foliage",
        name: "Fall Foliage",
        icon: "🍁",
        contents: "<!doctype html><title>hi</title>",
        source: { artifactId: "drv_1", threadId: "th_9" },
      });

      expect(installed?.id).toBe("foliage");
      expect(installed?.kind).toBe("page");
      expect(installed?.entryUrl).toBe("/app-assets/foliage/index.html");

      const read = yield* readInstalledApp({ stateDir: dir, appId: "foliage" });
      expect(read?.name).toBe("Fall Foliage");
      expect(read?.icon).toBe("🍁");
      // Provenance survives the round trip -- "which conversation made this?"
      // is the question the drive-first flow exists to keep answerable.
      expect(read?.source?.artifactId).toBe("drv_1");
      expect(read?.source?.threadId).toBe("th_9");
    }),
  );

  it.effect("lists installed apps", () =>
    Effect.gen(function* () {
      const dir = yield* stateDir();
      yield* installPageApp({ stateDir: dir, appId: "one", name: "One", contents: "<p>1</p>" });
      yield* installPageApp({ stateDir: dir, appId: "two", name: "Two", contents: "<p>2</p>" });

      const apps = yield* listInstalledApps({ stateDir: dir });
      expect(apps.map((app) => app.id).sort()).toEqual(["one", "two"]);
    }),
  );

  // A built-in's directory holds a store and settings but no manifest. It must
  // not surface as a user app, or Memory would appear on the rail twice.
  it.effect("ignores a directory with no manifest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      yield* fs.makeDirectory(path.join(dir, "apps", "memory"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "apps", "memory", "settings.json"), "{}");

      expect(yield* listInstalledApps({ stateDir: dir })).toEqual([]);
    }),
  );

  // One malformed folder must not take the whole rail down with it.
  it.effect("skips a malformed manifest and keeps the healthy apps", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      yield* installPageApp({ stateDir: dir, appId: "good", name: "Good", contents: "<p>ok</p>" });

      const brokenDir = path.join(dir, "apps", "broken");
      yield* fs.makeDirectory(brokenDir, { recursive: true });
      yield* fs.writeFileString(path.join(brokenDir, APP_MANIFEST_FILENAME), "{ not json");

      const apps = yield* listInstalledApps({ stateDir: dir });
      expect(apps.map((app) => app.id)).toEqual(["good"]);
    }),
  );

  // A manifest claiming a different id than its directory would make routes and
  // settings disagree about which app is which.
  it.effect("rejects a manifest whose id does not match its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      const appDir = path.join(dir, "apps", "claimed");
      yield* fs.makeDirectory(appDir, { recursive: true });
      yield* fs.writeFileString(path.join(appDir, "index.html"), "<p>x</p>");
      yield* fs.writeFileString(
        path.join(appDir, APP_MANIFEST_FILENAME),
        `{"id":"memory","name":"Not Memory","entry":"index.html"}`,
      );

      expect(yield* readInstalledApp({ stateDir: dir, appId: "claimed" })).toBeNull();
    }),
  );

  // An entry escaping the directory would turn the asset route into an arbitrary
  // file read of the state dir, which holds secrets and the thread database.
  it.effect("rejects an entry that escapes the app directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      const appDir = path.join(dir, "apps", "escapee");
      yield* fs.makeDirectory(appDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(appDir, APP_MANIFEST_FILENAME),
        `{"id":"escapee","name":"Escapee","entry":"../../settings.json"}`,
      );

      expect(yield* readInstalledApp({ stateDir: dir, appId: "escapee" })).toBeNull();
    }),
  );

  it.effect("rejects a manifest whose entry file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      const appDir = path.join(dir, "apps", "hollow");
      yield* fs.makeDirectory(appDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(appDir, APP_MANIFEST_FILENAME),
        `{"id":"hollow","name":"Hollow","entry":"index.html"}`,
      );

      expect(yield* readInstalledApp({ stateDir: dir, appId: "hollow" })).toBeNull();
    }),
  );

  // Re-installing is how an app is updated. The alternative -- refusing, or
  // minting `foo-2` -- turns "the agent made a new version" into a directory
  // full of near-duplicates.
  it.effect("overwrites on reinstall", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      yield* installPageApp({ stateDir: dir, appId: "v", name: "V", contents: "<p>v1</p>" });
      yield* installPageApp({ stateDir: dir, appId: "v", name: "V2", contents: "<p>v2</p>" });

      const contents = yield* fs.readFileString(path.join(dir, "apps", "v", "index.html"));
      expect(contents).toBe("<p>v2</p>");
      expect((yield* readInstalledApp({ stateDir: dir, appId: "v" }))?.name).toBe("V2");
      expect((yield* listInstalledApps({ stateDir: dir })).length).toBe(1);
    }),
  );
});

layer("uninstall", (it) => {
  it.effect("removes the app and its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      yield* installPageApp({ stateDir: dir, appId: "gone", name: "Gone", contents: "<p>x</p>" });

      expect(yield* uninstallApp({ stateDir: dir, appId: "gone" })).toBe(true);
      expect(yield* fs.exists(path.join(dir, "apps", "gone"))).toBe(false);
      expect(yield* listInstalledApps({ stateDir: dir })).toEqual([]);
    }),
  );

  // A bug in a caller must not be able to delete a built-in's store. Disabling a
  // built-in is a toggle, and that never touches data.
  it.effect("refuses to remove a directory that is not a user app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      const memoryDir = path.join(dir, "apps", "memory");
      yield* fs.makeDirectory(memoryDir, { recursive: true });
      yield* fs.writeFileString(path.join(memoryDir, "state.sqlite"), "not really a db");

      expect(yield* uninstallApp({ stateDir: dir, appId: "memory" })).toBe(false);
      expect(yield* fs.exists(path.join(memoryDir, "state.sqlite"))).toBe(true);
    }),
  );

  it.effect("reports false for an unknown app", () =>
    Effect.gen(function* () {
      const dir = yield* stateDir();
      expect(yield* uninstallApp({ stateDir: dir, appId: "nope" })).toBe(false);
    }),
  );
});
