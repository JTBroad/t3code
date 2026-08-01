import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  MemoryAppendDailyTool,
  MemoryReadDailyTool,
  MemorySearchTool,
  MemoryToolkit,
} from "./tools.ts";

const parameterKeys = (tool: { readonly parametersSchema: unknown }): ReadonlyArray<string> =>
  Object.keys((tool.parametersSchema as { fields?: Record<string, unknown> }).fields ?? {});

describe("memory toolkit surface", () => {
  it("exposes exactly the three memory tools", () => {
    expect(Object.keys(MemoryToolkit.tools).sort()).toEqual([
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

  it("keeps search filters optional so an unfiltered search is valid", () => {
    expect([...parameterKeys(MemorySearchTool)].sort()).toEqual(["limit", "scope", "tag"]);
  });
});
