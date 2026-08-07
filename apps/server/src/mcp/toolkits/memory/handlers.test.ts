import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  DriveWriteArtifactTool,
  MemoryAppendDailyTool,
  MemoryReadDailyTool,
  MemorySearchTool,
  MemoryToolkit,
} from "./tools.ts";

const parameterKeys = (tool: { readonly parametersSchema: unknown }): ReadonlyArray<string> =>
  Object.keys((tool.parametersSchema as { fields?: Record<string, unknown> }).fields ?? {});

describe("memory toolkit surface", () => {
  it("exposes exactly the memory and drive tools", () => {
    expect(Object.keys(MemoryToolkit.tools).sort()).toEqual([
      "drive_write_artifact",
      "memory_append_daily",
      "memory_read_daily",
      "memory_search",
    ]);
  });

  /**
   * The anti-spoofing guarantee is structural rather than validated at runtime:
   * provenance is taken from the MCP invocation scope, which the server issues.
   * If these ever become tool parameters, a model could attribute an
   * observation to another project and quietly poison recall there -- so the
   * absence of the parameters is the thing worth asserting.
   */
  it("takes no provenance parameters a model could set", () => {
    expect(parameterKeys(MemoryAppendDailyTool)).toEqual(["body"]);
    for (const forbidden of ["projectSegment", "threadId", "capturedAt", "repositoryPath"]) {
      expect(parameterKeys(MemoryAppendDailyTool)).not.toContain(forbidden);
    }
  });

  it("marks the read-only tools readonly and idempotent, and capture neither", () => {
    // Annotations drive how clients present and retry a tool. Capture is the
    // only one of the three that mutates anything.
    for (const tool of [MemoryReadDailyTool, MemorySearchTool]) {
      expect(Context.get(tool.annotations, Tool.Readonly)).toBe(true);
      expect(Context.get(tool.annotations, Tool.Idempotent)).toBe(true);
    }
    expect(Context.get(MemoryAppendDailyTool.annotations, Tool.Readonly)).toBe(false);
  });

  // Every one of these is optional, including `query`: omitting it lists recent
  // notes rather than erroring, so "show me what's there" stays one call.
  it("keeps search filters optional so an unfiltered search is valid", () => {
    expect([...parameterKeys(MemorySearchTool)].sort()).toEqual(["limit", "query", "scope", "tag"]);
  });

  it("lets no tool choose the project bucket it writes into", () => {
    // Same anti-spoofing property as capture: a model that picks the folder can
    // write into another project's drive.
    expect([...parameterKeys(DriveWriteArtifactTool)].sort()).toEqual([
      "contents",
      "kind",
      "relativePath",
    ]);
    expect(parameterKeys(DriveWriteArtifactTool)).not.toContain("projectSegment");
  });

  it("marks the artifact write as mutating but not destructive", () => {
    // It creates a new file; it does not overwrite a live path, because the
    // partial unique index rejects that until the old row is archived.
    expect(Context.get(DriveWriteArtifactTool.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(DriveWriteArtifactTool.annotations, Tool.Destructive)).toBe(false);
  });
});
