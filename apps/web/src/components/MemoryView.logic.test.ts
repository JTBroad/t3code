import { describe, expect, it } from "vite-plus/test";
import type { DriveArtifact, MemoryNoteSummary } from "@t3tools/contracts";

import {
  collectProjectSegments,
  collectTags,
  EMPTY_NOTE_FILTERS,
  filterArtifacts,
  filterNotes,
  formatByteSize,
  resolveSelectedId,
} from "./MemoryView.logic";

const note = (overrides: Partial<MemoryNoteSummary> = {}): MemoryNoteSummary => ({
  id: "202608011200",
  title: "Guard migrations",
  status: "active",
  scope: "project",
  projectSegment: "t3code-a41f2c",
  tags: ["workflow"],
  modifiedAt: "2026-08-01T12:00:00Z",
  ...overrides,
});

const artifact = (overrides: Partial<DriveArtifact> = {}): DriveArtifact => ({
  id: "drv_1",
  relativePath: "t3code-a41f2c/report.md",
  projectSegment: "t3code-a41f2c",
  kind: "report",
  byteSize: 1024,
  contentSha256: "abc",
  threadId: "th_1",
  turnId: null,
  checkpointRef: null,
  createdAt: "2026-08-01T12:00:00Z",
  archivedAt: null,
  ...overrides,
});

describe("filterNotes", () => {
  it("returns everything when no filter is set", () => {
    const notes = [note(), note({ id: "b", scope: "global" })];
    expect(filterNotes(notes, EMPTY_NOTE_FILTERS)).toHaveLength(2);
  });

  it("filters by scope, status and tag independently", () => {
    const notes = [
      note({ id: "a", scope: "global", status: "active", tags: ["workflow"] }),
      note({ id: "b", scope: "project", status: "demoted", tags: ["persistence"] }),
    ];

    expect(filterNotes(notes, { ...EMPTY_NOTE_FILTERS, scope: "global" })[0]?.id).toBe("a");
    expect(filterNotes(notes, { ...EMPTY_NOTE_FILTERS, status: "demoted" })[0]?.id).toBe("b");
    expect(filterNotes(notes, { ...EMPTY_NOTE_FILTERS, tag: "persistence" })[0]?.id).toBe("b");
  });

  it("searches titles and tags case-insensitively", () => {
    const notes = [
      note({ id: "a", title: "Guard migrations", tags: [] }),
      note({ id: "b", title: "Unrelated", tags: ["Persistence"] }),
    ];

    expect(filterNotes(notes, { ...EMPTY_NOTE_FILTERS, search: "GUARD" })[0]?.id).toBe("a");
    expect(filterNotes(notes, { ...EMPTY_NOTE_FILTERS, search: "persist" })[0]?.id).toBe("b");
  });

  it("treats a whitespace-only search as no search", () => {
    const notes = [note()];
    expect(filterNotes(notes, { ...EMPTY_NOTE_FILTERS, search: "   " })).toHaveLength(1);
  });

  it("applies filters together rather than as alternatives", () => {
    const notes = [
      note({ id: "a", scope: "global", tags: ["workflow"] }),
      note({ id: "b", scope: "global", tags: ["persistence"] }),
    ];

    const result = filterNotes(notes, {
      ...EMPTY_NOTE_FILTERS,
      scope: "global",
      tag: "persistence",
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("b");
  });
});

describe("collectTags", () => {
  it("deduplicates and sorts", () => {
    const notes = [note({ tags: ["workflow", "persistence"] }), note({ tags: ["workflow"] })];
    expect(collectTags(notes)).toEqual(["persistence", "workflow"]);
  });

  it("is empty for an empty corpus", () => {
    expect(collectTags([])).toEqual([]);
  });
});

describe("resolveSelectedId", () => {
  it("keeps a selection that is still present", () => {
    const rows = [note({ id: "a" }), note({ id: "b" })];
    expect(resolveSelectedId(rows, "b")).toBe("b");
  });

  it("falls back to the first row when the selection filters out", () => {
    // Otherwise the detail pane sits empty beside a populated list, which
    // reads as broken rather than as "nothing selected".
    const rows = [note({ id: "a" })];
    expect(resolveSelectedId(rows, "gone")).toBe("a");
  });

  it("selects the first row when nothing was selected", () => {
    expect(resolveSelectedId([note({ id: "a" })], null)).toBe("a");
  });

  it("returns null when there is nothing to select", () => {
    expect(resolveSelectedId([], "a")).toBeNull();
  });
});

describe("artifact filtering", () => {
  it("returns everything when no project is chosen", () => {
    const artifacts = [artifact(), artifact({ id: "b", projectSegment: "api-b72e44" })];
    expect(filterArtifacts(artifacts, null)).toHaveLength(2);
  });

  it("filters to one project", () => {
    const artifacts = [artifact(), artifact({ id: "b", projectSegment: "api-b72e44" })];
    expect(filterArtifacts(artifacts, "api-b72e44")[0]?.id).toBe("b");
  });

  it("omits unattributed artifacts from the project list", () => {
    const artifacts = [artifact({ projectSegment: null }), artifact({ id: "b" })];
    expect(collectProjectSegments(artifacts)).toEqual(["t3code-a41f2c"]);
  });
});

describe("formatByteSize", () => {
  it("keeps bytes whole and scales larger units", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1024)).toBe("1 KB");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(1024 * 1024)).toBe("1 MB");
  });

  it("does not render a nonsense size for bad input", () => {
    expect(formatByteSize(-1)).toBe("—");
    expect(formatByteSize(Number.NaN)).toBe("—");
  });
});
