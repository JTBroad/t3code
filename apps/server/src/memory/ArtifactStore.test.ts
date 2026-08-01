import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  archiveArtifact,
  artifactsCreatedSince,
  getArtifact,
  listArtifacts,
  notesCiting,
  writeArtifact,
} from "./ArtifactStore.ts";
import { reindexAll, writeNote, type MemoryNote } from "./NoteStore.ts";

const layer = it.layer(Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory()));

/** Fresh temp drive root, schema migrated, index cleared between tests. */
const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 36 });
  yield* sql`DELETE FROM drive_artifacts`;
  const driveRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-drive-" });
  const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-drive-notes-" });
  yield* reindexAll({ memoryRoot });
  return { driveRoot, memoryRoot };
});

const write = (driveRoot: string, overrides: Record<string, unknown> = {}) =>
  writeArtifact({
    driveRoot,
    projectSegment: "t3code-a41f2c",
    relativePath: "2026-08-01/report.md",
    contents: "# Report\n\nFindings.\n",
    kind: "report",
    createdAt: "2026-08-01T12:00:00Z",
    ...overrides,
  });

layer("artifact store", (it) => {
  it.effect("writes the file and indexes it with a content hash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { driveRoot } = yield* setup();

        const written = yield* write(driveRoot);

        expect(yield* fs.readFileString(written.absolutePath)).toContain("Findings.");
        // Namespaced by project so a file is attributable from its path alone.
        expect(written.relativePath).toBe("t3code-a41f2c/2026-08-01/report.md");

        const record = yield* getArtifact(written.id);
        expect(record?.content_sha256).toBe(written.contentSha256);
        expect(record?.byte_size).toBe(written.byteSize);
        expect(record?.kind).toBe("report");
      }),
    ),
  );

  it.effect("carries thread, turn, and checkpoint provenance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { driveRoot } = yield* setup();

        const written = yield* write(driveRoot, {
          threadId: "th_9f2c",
          turnId: "turn_3",
          checkpointRef: "refs/t3/checkpoint/3",
        });

        const record = yield* getArtifact(written.id);
        expect(record?.thread_id).toBe("th_9f2c");
        expect(record?.turn_id).toBe("turn_3");
        expect(record?.checkpoint_ref).toBe("refs/t3/checkpoint/3");
      }),
    ),
  );

  // A rejected path must leave nothing behind: no file, and no row that would
  // point at a file which was never written.
  it.effect("refuses a traversal without writing a file or a row", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { driveRoot } = yield* setup();

        const exit = yield* Effect.exit(
          write(driveRoot, { projectSegment: null, relativePath: "../escaped.md" }),
        );
        assert.ok(exit._tag === "Failure", "expected the traversal to be refused");

        expect(yield* listArtifacts({})).toEqual([]);
        expect(yield* fs.exists(path.join(path.dirname(driveRoot), "escaped.md"))).toBe(false);
      }),
    ),
  );

  it.effect(
    "rejects a second live artifact at the same path, then allows reuse after archiving",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { driveRoot } = yield* setup();

          const first = yield* write(driveRoot);
          const duplicate = yield* Effect.exit(write(driveRoot));
          assert.ok(duplicate._tag === "Failure", "expected the live path to be unique");

          yield* archiveArtifact({ id: first.id, archivedAt: "2026-08-01T13:00:00Z" });
          const second = yield* write(driveRoot);

          expect(second.id).not.toBe(first.id);
          // Only the live one is listed by default.
          expect((yield* listArtifacts({})).map((row) => row.id)).toEqual([second.id]);
          expect((yield* listArtifacts({ includeArchived: true })).length).toBe(2);
        }),
      ),
  );

  it.effect("filters by project segment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { driveRoot } = yield* setup();

        yield* write(driveRoot, { projectSegment: "api-3f9c01", relativePath: "a.md" });
        yield* write(driveRoot, { projectSegment: "web-b72e44", relativePath: "b.md" });

        const rows = yield* listArtifacts({ projectSegment: "api-3f9c01" });
        expect(rows.map((row) => row.project_segment)).toEqual(["api-3f9c01"]);
      }),
    ),
  );

  it.effect("returns artifacts created since a marker, oldest first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { driveRoot } = yield* setup();

        yield* write(driveRoot, { relativePath: "old.md", createdAt: "2026-08-01T09:00:00Z" });
        yield* write(driveRoot, { relativePath: "new.md", createdAt: "2026-08-01T15:00:00Z" });

        const since = yield* artifactsCreatedSince({ since: "2026-08-01T12:00:00Z" });
        expect(since.map((row) => row.relative_path)).toEqual(["t3code-a41f2c/new.md"]);

        const all = yield* artifactsCreatedSince({ since: null });
        expect(all.map((row) => row.relative_path)).toEqual([
          "t3code-a41f2c/old.md",
          "t3code-a41f2c/new.md",
        ]);
      }),
    ),
  );
});

layer("provenance in both directions", (it) => {
  it.effect("reports which notes cite an artifact", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { driveRoot, memoryRoot } = yield* setup();
        const written = yield* write(driveRoot);

        const note: MemoryNote = {
          id: "202608011412",
          title: "Guard migrations",
          status: "active",
          scope: "global",
          projectSegment: null,
          repositoryPath: null,
          tags: [],
          links: [],
          sources: [
            { artifact: written.id, rel: "derived-from", context: "Migration review notes." },
          ],
          created: "2026-08-01T14:12:00Z",
          modified: "2026-08-01T14:12:00Z",
          body: "Behavioral effect: lead with the guard.",
        };
        yield* writeNote({ memoryRoot, note });

        const citing = yield* notesCiting(written.id);
        expect(citing.map((row) => row.note_id)).toEqual(["202608011412"]);
        expect(citing[0]?.title).toBe("Guard migrations");
        expect(citing[0]?.context).toBe("Migration review notes.");
      }),
    ),
  );
});
