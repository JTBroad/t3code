import { describe, expect, it } from "@effect/vitest";

import { APP_MEMORY_METHODS, LEGACY_MEMORY_METHODS } from "./memory.ts";
import { WS_METHODS } from "../rpc.ts";

describe("memory app method names", () => {
  it("namespaces every method under the app that owns it", () => {
    for (const method of Object.values(APP_MEMORY_METHODS)) {
      expect(method.startsWith("app.memory.")).toBe(true);
    }
  });

  // The compatibility promise: a client one release behind calls these names and
  // must still reach a handler. Dropping one is a silent break for any client
  // that has not updated -- mobile ships through app stores on its own schedule.
  it("keeps a legacy alias for every current method", () => {
    expect(Object.keys(LEGACY_MEMORY_METHODS).sort()).toEqual(
      Object.keys(APP_MEMORY_METHODS).sort(),
    );
  });

  it("keeps the legacy names exactly as they shipped", () => {
    expect(LEGACY_MEMORY_METHODS).toEqual({
      consolidate: "memory.consolidate",
      readDaily: "memory.readDaily",
      listNotes: "memory.listNotes",
      getNote: "memory.getNote",
      listArtifacts: "memory.listArtifacts",
      getArtifact: "memory.getArtifact",
    });
  });

  // Both names have to reach the router, or the alias is decorative.
  it("registers both names in the shared method map", () => {
    const registered = new Set<string>(Object.values(WS_METHODS));
    for (const method of [
      ...Object.values(APP_MEMORY_METHODS),
      ...Object.values(LEGACY_MEMORY_METHODS),
    ]) {
      expect(registered.has(method)).toBe(true);
    }
  });

  it("does not collide a current name with a legacy one", () => {
    const current = new Set<string>(Object.values(APP_MEMORY_METHODS));
    for (const legacy of Object.values(LEGACY_MEMORY_METHODS)) {
      expect(current.has(legacy)).toBe(false);
    }
  });
});
