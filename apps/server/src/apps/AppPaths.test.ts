import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { isValidAppId, resolveAppPaths } from "./AppPaths.ts";

describe("isValidAppId", () => {
  it("accepts lowercase dash-separated ids", () => {
    expect(isValidAppId("memory")).toBe(true);
    expect(isValidAppId("schedule")).toBe(true);
    expect(isValidAppId("my-custom-app2")).toBe(true);
  });

  // Excluding dots is what makes traversal impossible without a second check:
  // no accepted id can contain "..", so no accepted id can escape the apps dir.
  it("rejects anything that could escape the apps directory", () => {
    expect(isValidAppId("..")).toBe(false);
    expect(isValidAppId("../core")).toBe(false);
    expect(isValidAppId("a/b")).toBe(false);
    expect(isValidAppId("a\\b")).toBe(false);
    expect(isValidAppId("a.b")).toBe(false);
    expect(isValidAppId("a\0b")).toBe(false);
  });

  it("rejects shapes that are not the canonical form", () => {
    expect(isValidAppId("")).toBe(false);
    expect(isValidAppId("Memory")).toBe(false);
    expect(isValidAppId("-memory")).toBe(false);
    expect(isValidAppId("memory-")).toBe(false);
    expect(isValidAppId("memory--store")).toBe(false);
    expect(isValidAppId("memory store")).toBe(false);
    expect(isValidAppId("a".repeat(49))).toBe(false);
  });
});

describe("resolveAppPaths", () => {
  it("puts every app under <stateDir>/apps/<appId>", () => {
    const resolved = resolveAppPaths({ stateDir: "/state", appId: "memory" });
    expect(resolved?.dataDirectory).toBe(NodePath.join("/state", "apps", "memory"));
    expect(resolved?.databasePath).toBe(NodePath.join("/state", "apps", "memory", "state.sqlite"));
    expect(resolved?.settingsPath).toBe(NodePath.join("/state", "apps", "memory", "settings.json"));
  });

  it("keeps two apps in separate directories", () => {
    const memory = resolveAppPaths({ stateDir: "/state", appId: "memory" });
    const schedule = resolveAppPaths({ stateDir: "/state", appId: "schedule" });
    expect(memory?.dataDirectory).not.toBe(schedule?.dataDirectory);
  });

  // Null rather than a clamped path: a bad id is a bug or an attack, and
  // silently correcting it hides both.
  it("returns null for an invalid id instead of correcting it", () => {
    expect(resolveAppPaths({ stateDir: "/state", appId: "../escape" })).toBeNull();
    expect(resolveAppPaths({ stateDir: "/state", appId: ".." })).toBeNull();
  });

  it("resolves inside the state directory it was given", () => {
    const resolved = resolveAppPaths({ stateDir: "/state", appId: "memory" });
    expect(resolved?.dataDirectory.startsWith(NodePath.join("/state", "apps"))).toBe(true);
  });
});
