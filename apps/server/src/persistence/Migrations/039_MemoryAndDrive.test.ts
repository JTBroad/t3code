import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const migrateToCurrent = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 38 });
  yield* runMigrations({ toMigrationInclusive: 39 });
});

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    return columns.map((column) => column.name);
  });

layer("039_MemoryAndDrive", (it) => {
  it.effect("creates the four store tables with their expected columns", () =>
    Effect.gen(function* () {
      yield* migrateToCurrent;

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
    }),
  );

  it.effect("indexes the live artifact path uniquely but only while unarchived", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrateToCurrent;

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
      yield* migrateToCurrent;

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
      yield* migrateToCurrent;

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(memory_note_links)
      `;
      assert.ok(indexes.some((index) => index.name === "idx_note_links_backlinks"));

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA index_info('idx_note_links_backlinks')
      `;
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ["to_note_id"],
      );
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      yield* migrateToCurrent;
      yield* runMigrations({ toMigrationInclusive: 36 });

      assert.ok((yield* columnNames("memory_notes")).includes("scope"));
    }),
  );
});
