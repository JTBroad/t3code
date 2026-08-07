import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

// Each case needs its own database: one of them asserts on a *missing* column,
// which a suite-shared in-memory connection would have already created.
const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const pinColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  return columns.map((column) => column.name).filter((name) => name.startsWith("pin"));
});

describe("040_ProjectionThreadsPinnedRepair", () => {
  it.effect("leaves pinned_at in place when 036 already ran", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 40 });

        const columns = yield* pinColumns;
        assert.isTrue(columns.includes("pinned_at"));
        assert.isTrue(columns.includes("pin_order_key"));
      }),
    ),
  );

  // The bug this migration exists for: the fork shipped its own 036, so
  // databases created before the upstream sync record id 36 under a different
  // name. The migrator skips by id alone, so upstream's 036 never ran and
  // `pinned_at` was missing while `pin_order_key` (038) was present.
  it.effect("adds pinned_at on a database that skipped 036 under the fork's name", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 35 });
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (36, 'MemoryAndDrive', '2026-08-03 18:25:29')
        `;

        yield* runMigrations({ toMigrationInclusive: 38 });
        const beforeRepair = yield* pinColumns;
        assert.isFalse(
          beforeRepair.includes("pinned_at"),
          "expected the skipped 036 to leave pinned_at missing",
        );
        assert.isTrue(beforeRepair.includes("pin_order_key"));

        yield* runMigrations({ toMigrationInclusive: 40 });

        assert.isTrue((yield* pinColumns).includes("pinned_at"));
      }),
    ),
  );

  it.effect("is idempotent when re-run", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 40 });
        yield* runMigrations({ toMigrationInclusive: 40 });

        const columns = yield* pinColumns;
        assert.strictEqual(columns.filter((name) => name === "pinned_at").length, 1);
      }),
    ),
  );
});
