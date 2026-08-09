/**
 * AppDatabase - A SQLite file and migration sequence per app.
 *
 * Every app gets `<stateDir>/apps/<appId>/state.sqlite` with its own migrations
 * numbered from 001, instead of tables in the shared database numbered inside the
 * shared sequence. Three things follow:
 *
 * - **Fork merges stop colliding.** A fork-local table in the shared sequence is
 *   a future merge conflict with a data-loss tail; `f40c7012c` is what that looks
 *   like when it goes wrong. An app's sequence is only ever appended to by the
 *   app.
 * - **Uninstall is a directory delete.** No rows to hunt down, no foreign keys
 *   into core.
 * - **A broken app cannot corrupt thread state.** It has no handle on the core
 *   database at all -- the type system says so, because app code asks for its own
 *   tag rather than for `SqlClient`.
 *
 * The cost is no cross-database joins and no transaction spanning core and app
 * state. Memory pays neither: it reads core only through `AppHost`, and its rows
 * are a rebuildable index over authoritative files rather than primary data.
 *
 * @module AppDatabase
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Migrator from "effect/unstable/sql/Migrator";

import { resolveAppPaths } from "./AppPaths.ts";
import { ServerConfig } from "../config.ts";

type Loader = {
  layer: (config: {
    readonly filename: string;
    readonly spanAttributes?: Record<string, unknown>;
  }) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};

/** Same runtime split as core persistence: Bun's client when on Bun, else Node's. */
const sqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../persistence/NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeClientLayer = Effect.fn("makeAppSqliteClient")(function* (input: {
  readonly appId: string;
  readonly filename: string;
}) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const clientModule = yield* Effect.promise<Loader>(sqliteClientLoaders[runtime]);
  return clientModule.layer({
    filename: input.filename,
    spanAttributes: { "db.name": `app:${input.appId}`, "service.name": "t3-server" },
  });
}, Layer.unwrap);

const runAppMigrations = Migrator.make({});

/** An app's migrations, as `[id, name, effect]` in ascending id order. */
export type AppMigrationEntries = ReadonlyArray<
  readonly [number, string, Effect.Effect<void, SqlError, SqlClient.SqlClient>]
>;

/**
 * Build an app's database layer: its own file, its own migration sequence.
 *
 * The returned layer provides `SqlClient` -- app modules are expected to rebind
 * it to their own tag immediately (see `MemoryDb`) so that nothing can reach this
 * client by asking for `SqlClient` in a context where core's is also present.
 */
export const makeAppDatabaseLayer = Effect.fn("makeAppDatabaseLayer")(function* (input: {
  readonly appId: string;
  readonly migrations: AppMigrationEntries;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const paths = resolveAppPaths({ stateDir: config.stateDir, appId: input.appId });
  if (paths === null) {
    // A registry entry with an unusable id is a programming error, not a runtime
    // condition -- there is no sensible fallback directory to pick.
    return yield* Effect.die(new Error(`not a valid app id: ${input.appId}`));
  }

  yield* fs.makeDirectory(path.dirname(paths.databasePath), { recursive: true });

  const setup = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* runAppMigrations({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            input.migrations.map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });
    }),
  );

  return Layer.provideMerge(
    setup,
    makeClientLayer({ appId: input.appId, filename: paths.databasePath }),
  );
}, Layer.unwrap);

/** In-memory app database, for tests. Runs the same migration sequence. */
export const makeAppDatabaseMemoryLayer = (migrations: AppMigrationEntries) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const clientModule = yield* Effect.promise<Loader>(
        process.versions.bun !== undefined ? sqliteClientLoaders.bun : sqliteClientLoaders.node,
      );
      const setup = Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA foreign_keys = ON;`;
          yield* runAppMigrations({
            loader: Migrator.fromRecord(
              Object.fromEntries(
                migrations.map(([id, name, migration]) => [`${id}_${name}`, migration]),
              ),
            ),
          });
        }),
      );
      return Layer.provideMerge(setup, clientModule.layer({ filename: ":memory:" }));
    }),
  );
