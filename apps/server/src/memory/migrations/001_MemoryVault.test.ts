/**
 * Schema tests for the memory app's own store.
 *
 * These moved here from `039_MemoryAndDrive.test.ts` when the tables did. The
 * properties are the same ones that mattered before -- what is different is only
 * which database they hold in.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeAppDatabaseMemoryLayer } from "../../apps/AppDatabase.ts";
import { MEMORY_MIGRATIONS } from "../MemoryDb.ts";

const layer = it.layer(makeAppDatabaseMemoryLayer(MEMORY_MIGRATIONS));

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    return columns.map((column) => column.name);
  });

layer("001_MemoryVault", (it) => {
  it.effect("creates the store tables with their expected columns", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* columnNames("drive_artifacts"), [
        "id",
        "relative_path",
        "project_segment",
        "repository_path",
        "thread_id",
        "turn_id",
        "checkpoint_ref",
        "kind",
        "byte_size",
        "content_sha256",
        "created_at",
        "archived_at",
      ]);
      assert.deepStrictEqual(yield* columnNames("memory_notes"), [
        "id",
        "title",
        "status",
        "scope",
        "project_segment",
        "repository_path",
        "tags",
        "created_at",
        "modified_at",
      ]);
      assert.deepStrictEqual(yield* columnNames("memory_note_sources"), [
        "note_id",
        "artifact_id",
        "relation",
        "context",
        "created_at",
      ]);
      assert.deepStrictEqual(yield* columnNames("memory_note_links"), [
        "from_note_id",
        "to_note_id",
        "relation",
        "context",
        "created_at",
      ]);
      assert.deepStrictEqual(yield* columnNames("memory_note_wikilinks"), [
        "from_note_id",
        "target_title",
        "to_note_id",
        "is_ambiguous",
        "created_at",
      ]);
    }),
  );

  it.effect("indexes the live artifact path uniquely but only while unarchived", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const indexes = yield* sql<{
        readonly name: string;
        readonly unique: number;
        readonly partial: number;
      }>`
        PRAGMA index_list(drive_artifacts)
      `;
      const livePathIndex = indexes.find((index) => index.name === "idx_drive_artifacts_live_path");
      assert.ok(livePathIndex, "expected the live-path index to exist");
      assert.strictEqual(livePathIndex.unique, 1);
      assert.strictEqual(livePathIndex.partial, 1);
    }),
  );

  it.effect("frees an artifact path for reuse once the previous row is archived", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const insert = (id: string, archivedAt: string | null) => sql`
        INSERT INTO drive_artifacts
          (id, relative_path, kind, byte_size, content_sha256, created_at, archived_at)
        VALUES
          (${id}, 'proj/report.md', 'report', 10, 'abc', '2026-08-01T00:00:00Z', ${archivedAt})
      `;

      yield* insert("first", null);

      // Same live path twice must fail: that is what the unique index is for.
      const duplicate = yield* Effect.exit(insert("second", null));
      assert.ok(duplicate._tag === "Failure", "expected a duplicate live path to be rejected");

      // Archiving the original releases the path, so a re-run can reuse the
      // natural filename instead of inventing a suffix.
      yield* sql`UPDATE drive_artifacts SET archived_at = '2026-08-01T01:00:00Z' WHERE id = 'first'`;
      yield* insert("second", null);

      const rows = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM drive_artifacts WHERE relative_path = 'proj/report.md'`;
      assert.strictEqual(Number(rows[0]?.count), 2);
    }),
  );

  it.effect("indexes backlinks so 'which notes link here' avoids a corpus scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      for (const [table, index, column] of [
        ["memory_note_links", "idx_note_links_backlinks", "to_note_id"],
        ["memory_note_wikilinks", "idx_note_wikilinks_target", "to_note_id"],
      ] as const) {
        const indexes = yield* sql<{ readonly name: string }>`
          PRAGMA index_list(${sql.literal(table)})
        `;
        assert.ok(
          indexes.some((entry) => entry.name === index),
          `expected ${index} on ${table}`,
        );

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA index_info(${sql.literal(index)})
        `;
        assert.deepStrictEqual(
          columns.map((entry) => entry.name),
          [column],
        );
      }
    }),
  );

  // Search is only useful if the index is queryable, and an FTS5 table that
  // failed to create would otherwise surface as an empty result rather than an
  // error.
  it.effect("creates a usable full-text index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_notes_fts (note_id, title, body) VALUES ('n_1', 'Title', 'body words')`;

      const rows = yield* sql<{
        readonly note_id: string;
      }>`SELECT note_id FROM memory_notes_fts WHERE memory_notes_fts MATCH '"words"'`;
      assert.deepStrictEqual(
        rows.map((row) => row.note_id),
        ["n_1"],
      );
    }),
  );
});
