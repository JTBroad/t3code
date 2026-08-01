import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { appendDailyEntry, readDaily } from "./DailyStore.ts";
import {
  noteIdFor,
  parseDailyEntries,
  readLastConsolidatedAt,
  SUMMARIES_DIRNAME,
  runConsolidation,
} from "./Consolidation.ts";
import { listNotes, reindexAll } from "./NoteStore.ts";

const layer = it.layer(Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory()));

const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 36 });
  yield* sql`DELETE FROM drive_artifacts`;
  const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-consolidate-" });
  yield* reindexAll({ memoryRoot });
  return memoryRoot;
});

const capture = (memoryRoot: string, body: string, projectSegment: string | null) =>
  appendDailyEntry({
    memoryRoot,
    body,
    provenance: {
      capturedAt: "2026-08-01T12:00:00Z",
      projectSegment,
      threadId: "th_1",
    },
  });

describe("daily entry parsing", () => {
  it("recovers provenance from each entry header", () => {
    const entries = parseDailyEntries(
      [
        "## 2026-08-01T12:00:00Z · api-3f9c01 · thread th_1",
        "Prefers guarded migrations.",
        "",
        "## 2026-08-01T13:00:00Z · unattributed · thread unattributed",
        "Something with no project.",
        "",
      ].join("\n"),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.projectSegment).toBe("api-3f9c01");
    expect(entries[0]?.body).toBe("Prefers guarded migrations.");
    // "unattributed" is a marker, not a project named "unattributed".
    expect(entries[1]?.projectSegment).toBeNull();
    expect(entries[1]?.threadId).toBeNull();
  });

  it("ignores scaffolding with no entries", () => {
    expect(parseDailyEntries("# Daily\n\nShort-term capture.\n")).toEqual([]);
  });

  it("derives a stable note id from the capture time and body", () => {
    const id = noteIdFor("2026-08-01T12:00:00Z", "an observation");
    expect(id).toMatch(/^202608011200[0-9a-f]{4}$/);
    // Same observation re-promoted is idempotent, not duplicated.
    expect(noteIdFor("2026-08-01T12:00:00Z", "an observation")).toBe(id);
  });

  // Regression: ids were disambiguated by position within a run, so two
  // observations captured in the same second in different runs collided and
  // the second silently overwrote the first.
  it("gives different observations different ids at the same timestamp", () => {
    expect(noteIdFor("2026-08-01T12:00:00Z", "first")).not.toBe(
      noteIdFor("2026-08-01T12:00:00Z", "second"),
    );
  });
});

layer("consolidation", (it) => {
  it.effect("promotes entries into notes with the right scope per project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* capture(memoryRoot, "Project-specific convention.", "api-3f9c01");
        yield* capture(memoryRoot, "A user-level preference.", null);

        const outcome = yield* runConsolidation({ memoryRoot });
        assert.ok(outcome.kind === "completed");
        expect(outcome.promoted).toBe(2);

        const notes = yield* listNotes({});
        const byScope = new Map(notes.map((row) => [row.scope, row]));
        expect(byScope.get("project")?.project_segment).toBe("api-3f9c01");
        expect(byScope.get("global")?.project_segment).toBeNull();
      }),
    ),
  );

  it.effect("clears the buffer and advances the marker once complete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* capture(memoryRoot, "Something worth keeping.", null);

        expect(yield* readLastConsolidatedAt(memoryRoot)).toBeNull();
        yield* runConsolidation({ memoryRoot });

        expect(yield* readDaily({ memoryRoot })).not.toContain("Something worth keeping.");
        expect(yield* readLastConsolidatedAt(memoryRoot)).not.toBeNull();
      }),
    ),
  );

  it.effect("reports nothing-to-do on an empty buffer and stays runnable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();

        expect((yield* runConsolidation({ memoryRoot })).kind).toBe("nothing-to-do");
        // The lock must have been released, or this second call would report
        // already-running forever.
        expect((yield* runConsolidation({ memoryRoot })).kind).toBe("nothing-to-do");
      }),
    ),
  );

  it.effect("lets only one of two concurrent runs promote", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* capture(memoryRoot, "Recorded exactly once.", null);

        const [first, second] = yield* Effect.all(
          [runConsolidation({ memoryRoot }), runConsolidation({ memoryRoot })],
          { concurrency: 2 },
        );

        const kinds = [first.kind, second.kind].sort();
        expect(kinds).toEqual(["already-running", "completed"]);

        // Promoted exactly once: a double promotion would duplicate the note.
        expect((yield* listNotes({})).length).toBe(1);
      }),
    ),
  );

  // The rule that is easiest to violate: a cycle must not consume its own
  // output, or every run spends more of its budget reprocessing its exhaust.
  it.effect("never promotes its own summary on a later run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* setup();

        yield* capture(memoryRoot, "First observation.", null);
        const first = yield* runConsolidation({ memoryRoot });
        assert.ok(first.kind === "completed");

        // The summary exists, and lives outside the note corpus.
        expect(yield* fs.exists(first.summaryPath)).toBe(true);
        expect(path.dirname(first.summaryPath)).toBe(path.join(memoryRoot, SUMMARIES_DIRNAME));

        yield* capture(memoryRoot, "Second observation.", null);
        const second = yield* runConsolidation({ memoryRoot });
        assert.ok(second.kind === "completed");

        // One note per real observation -- the summary contributed none.
        expect(second.promoted).toBe(1);
        expect((yield* listNotes({})).length).toBe(2);
      }),
    ),
  );

  it.effect("records artifacts from the same project as note sources", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO drive_artifacts
            (id, relative_path, project_segment, kind, byte_size, content_sha256, created_at)
          VALUES ('drv_1', 'api-3f9c01/report.md', 'api-3f9c01', 'report', 10, 'abc',
                  '2026-08-01T11:00:00Z')
        `;

        yield* capture(memoryRoot, "Learned from the report.", "api-3f9c01");
        const outcome = yield* runConsolidation({ memoryRoot });
        assert.ok(outcome.kind === "completed");
        expect(outcome.artifactsConsulted).toBe(1);

        const citing = yield* sql<{ readonly artifact_id: string }>`
          SELECT artifact_id FROM memory_note_sources
        `;
        expect(citing.map((row) => row.artifact_id)).toEqual(["drv_1"]);
      }),
    ),
  );
});
