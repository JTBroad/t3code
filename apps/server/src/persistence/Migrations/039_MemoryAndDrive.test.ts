import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * 039 created the memory and drive tables in the core database. They now live in
 * the memory app's own store, and this entry is a tombstone.
 *
 * The schema assertions that used to live here moved with the tables, to
 * `memory/migrations/001_MemoryVault.test.ts`. What is left is the contract a
 * tombstone has to keep: it still exists, still holds its number, and creates
 * nothing.
 */
layer("039_MemoryAndDrive (tombstone)", (it) => {
  // Removing the entry would renumber the sequence and make every database that
  // already ran it disagree with the manifest -- the exact failure that
  // 040_ProjectionThreadsPinnedRepair exists to repair.
  it("keeps its id and name in the manifest", () => {
    assert.ok(
      migrationManifest.some(([id, name]) => id === 39 && name === "MemoryAndDrive"),
      "expected migration 39 to remain in the manifest",
    );
  });

  it.effect("creates no tables of its own", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const names = new Set(tables.map((table) => table.name));

      for (const moved of [
        "drive_artifacts",
        "memory_notes",
        "memory_note_links",
        "memory_note_sources",
      ]) {
        assert.ok(!names.has(moved), `expected ${moved} to live in the app store, not core`);
      }
    }),
  );

  it.effect("still runs cleanly as part of the sequence", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* runMigrations({ toMigrationInclusive: 39 });
      // Re-running is a no-op rather than an error, so a database that already
      // recorded it is untouched.
      yield* runMigrations({ toMigrationInclusive: 39 });
    }),
  );
});
