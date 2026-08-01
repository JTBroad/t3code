import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  BRIEF_CLOSE_MARKER,
  BRIEF_OPEN_MARKER,
  prependBrief,
  readLatestSummary,
  stripDailyScaffold,
  stripSummaryHeading,
} from "./BriefInjection.ts";
import { SUMMARIES_DIRNAME } from "./Consolidation.ts";
import { DAILY_SCAFFOLD } from "./DailyStore.ts";

const layer = it.layer(NodeServices.layer);

describe("prependBrief", () => {
  it("leaves the message untouched when there is no brief", () => {
    expect(prependBrief("", "fix the migration")).toBe("fix the migration");
    expect(prependBrief("   \n  ", "fix the migration")).toBe("fix the migration");
  });

  it("marks the brief as context so it does not read as the user's request", () => {
    const result = prependBrief("# Continuity brief\n\n## Themes\n- Guard migrations", "ship it");

    expect(result).toContain(BRIEF_OPEN_MARKER);
    expect(result).toContain(BRIEF_CLOSE_MARKER);
    expect(result).toContain("not part of their message");
    // The user's own words survive verbatim and come last.
    expect(result.endsWith("ship it")).toBe(true);
  });

  it("keeps the brief ahead of the message", () => {
    const result = prependBrief("BRIEF_BODY", "USER_REQUEST");
    expect(result.indexOf("BRIEF_BODY")).toBeLessThan(result.indexOf("USER_REQUEST"));
  });
});

describe("stripDailyScaffold", () => {
  it("treats an untouched buffer as empty", () => {
    expect(stripDailyScaffold(DAILY_SCAFFOLD)).toBe("");
    expect(stripDailyScaffold("")).toBe("");
  });

  it("keeps captured entries", () => {
    const contents = `${DAILY_SCAFFOLD}\n## 2026-08-01T12:00:00Z · t3code-a41f2c · thread th_1\nPrefers guarded migrations.\n`;
    const result = stripDailyScaffold(contents);

    expect(result).toContain("Prefers guarded migrations.");
    expect(result).not.toContain("Short-term capture");
  });
});

describe("stripSummaryHeading", () => {
  it("drops the summary's own title but keeps its body", () => {
    const result = stripSummaryHeading(
      "# Consolidation 2026-08-01T12:00:00Z\n\n- Entries read: 3\n- Notes promoted: 2\n",
    );

    expect(result).not.toContain("# Consolidation");
    expect(result).toContain("- Notes promoted: 2");
  });
});

describe("readLatestSummary", () => {
  layer((it) => {
    it.effect("returns empty when consolidation has never run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-brief-" });

        expect(yield* readLatestSummary({ memoryRoot })).toBe("");
      }),
    );

    it.effect("picks the newest summary, not just any summary", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-brief-" });
        const directory = path.join(memoryRoot, SUMMARIES_DIRNAME);
        yield* fs.makeDirectory(directory, { recursive: true });

        // Filenames are ISO stamps with ':' and '.' replaced, so lexical order
        // is chronological order -- this asserts that assumption holds.
        yield* fs.writeFileString(
          path.join(directory, "2026-08-01T09-00-00-000Z.md"),
          "# Consolidation\n\nolder run\n",
        );
        yield* fs.writeFileString(
          path.join(directory, "2026-08-01T17-00-00-000Z.md"),
          "# Consolidation\n\nnewer run\n",
        );

        const result = yield* readLatestSummary({ memoryRoot });
        expect(result).toContain("newer run");
        expect(result).not.toContain("older run");
      }),
    );

    it.effect("ignores non-markdown files in the summary directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-brief-" });
        const directory = path.join(memoryRoot, SUMMARIES_DIRNAME);
        yield* fs.makeDirectory(directory, { recursive: true });

        yield* fs.writeFileString(
          path.join(directory, "2026-08-01T09-00-00-000Z.md"),
          "real run\n",
        );
        yield* fs.writeFileString(path.join(directory, "zz-not-a-summary.txt"), "noise\n");

        expect(yield* readLatestSummary({ memoryRoot })).toContain("real run");
      }),
    );
  });
});
