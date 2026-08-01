import { describe, expect, it } from "vite-plus/test";

import {
  normalizeStoreRelativePath,
  resolveDriveRoot,
  resolveMemoryRoot,
  resolveWithinRoot,
  toProjectSegment,
} from "./MemoryPaths.ts";

const DERIVED = {
  memoryDir: "/state/userdata/memory",
  driveDir: "/state/userdata/drive",
};

describe("root resolution", () => {
  it("falls back to the stateDir-derived default when unset", () => {
    expect(resolveMemoryRoot({ memoryRootDirectory: "" }, DERIVED)).toBe(DERIVED.memoryDir);
    expect(resolveDriveRoot({ driveRootDirectory: "" }, DERIVED)).toBe(DERIVED.driveDir);
  });

  it("prefers a configured root", () => {
    expect(resolveMemoryRoot({ memoryRootDirectory: "/notes" }, DERIVED)).toBe("/notes");
    expect(resolveDriveRoot({ driveRootDirectory: "/generated" }, DERIVED)).toBe("/generated");
  });

  it("treats a whitespace-only setting as unset", () => {
    expect(resolveMemoryRoot({ memoryRootDirectory: "   " }, DERIVED)).toBe(DERIVED.memoryDir);
  });
});

describe("containment guard", () => {
  const root = "/store";

  it("resolves an ordinary relative path inside the root", () => {
    expect(resolveWithinRoot({ root, relativePath: "notes/202607311412.md" })).toBe(
      "/store/notes/202607311412.md",
    );
  });

  // Each of these must be refused outright. Returning a clamped path instead
  // would silently write somewhere the caller did not ask for.
  it.each([
    ["parent traversal", "../escape.md"],
    ["nested traversal", "a/../../escape.md"],
    ["deep traversal", "a/b/../../../escape.md"],
    ["empty path", ""],
    ["dot only", "."],
    ["NUL byte", "notes/evil\u0000.md"],
  ])("refuses %s", (_label, relativePath) => {
    expect(resolveWithinRoot({ root, relativePath })).toBeNull();
  });

  // An absolute path is contained, not honored: the leading slash is stripped
  // so it lands inside the root rather than escaping to the real /etc.
  it("contains an absolute path inside the root instead of honoring it", () => {
    expect(resolveWithinRoot({ root, relativePath: "/etc/passwd" })).toBe("/store/etc/passwd");
  });

  // A sibling directory sharing a name prefix must not count as inside.
  it("does not treat a prefix-sharing sibling root as contained", () => {
    expect(resolveWithinRoot({ root: "/store", relativePath: "../store-backup/x.md" })).toBeNull();
  });

  it("normalizes separators and strips leading slashes", () => {
    expect(normalizeStoreRelativePath("/a/b.md")).toBe("a/b.md");
    expect(normalizeStoreRelativePath("a\\b.md")).toBe("a/b.md");
  });
});

describe("project segments", () => {
  it("is stable for the same path", () => {
    expect(toProjectSegment("/Users/jt/code/t3code")).toBe(
      toProjectSegment("/Users/jt/code/t3code"),
    );
  });

  // The reason the hash suffix exists: without it these collapse to one bucket
  // and two projects' notes merge.
  it("distinguishes same-named repos under different parents", () => {
    const a = toProjectSegment("/a/api");
    const b = toProjectSegment("/b/api");
    expect(a).not.toBe(b);
    expect(a?.startsWith("api-")).toBe(true);
    expect(b?.startsWith("api-")).toBe(true);
  });

  it("sanitizes characters that are unsafe in a folder name", () => {
    const segment = toProjectSegment("/tmp/My Project (v2)");
    expect(segment).toMatch(/^[a-z0-9_-]+$/);
  });

  it("still produces a unique segment when the name sanitizes to nothing", () => {
    const segment = toProjectSegment("/!!!");
    expect(segment).toMatch(/^[0-9a-f]{6}$/);
  });

  it("returns null for an empty path", () => {
    expect(toProjectSegment("   ")).toBeNull();
  });
});
