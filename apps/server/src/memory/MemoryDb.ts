/**
 * MemoryDb - The memory app's database handle.
 *
 * A distinct tag rather than `SqlClient`, even though the value is a SqlClient.
 * Both databases are live in the same runtime, so if memory asked for
 * `SqlClient` it would silently get whichever one happened to be in context --
 * core's, in most call paths. The tag makes "which database is this query
 * against?" a type-level fact instead of a wiring accident, and it means nothing
 * outside this app can reach the app's store by asking for a generic service.
 *
 * @module MemoryDb
 */
import { APP_ID_MEMORY } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import MemoryVaultMigration from "./migrations/001_MemoryVault.ts";
import {
  makeAppDatabaseLayer,
  makeAppDatabaseMemoryLayer,
  type AppMigrationEntries,
} from "../apps/AppDatabase.ts";

/**
 * The memory app's migration sequence.
 *
 * Numbered from 001 and owned entirely by this app. Upstream never appends here,
 * which is the whole reason the store moved out of the core sequence.
 */
export const MEMORY_MIGRATIONS: AppMigrationEntries = [[1, "MemoryVault", MemoryVaultMigration]];

export class MemoryDb extends Context.Service<MemoryDb, SqlClient.SqlClient>()(
  "t3/memory/MemoryDb",
) {}

/** Rebind the app database's `SqlClient` to {@link MemoryDb}. */
const rebind = Layer.effect(
  MemoryDb,
  Effect.map(SqlClient.SqlClient, (client) => MemoryDb.of(client)),
);

/** The memory app's real store, at `<stateDir>/apps/memory/state.sqlite`. */
export const layer = rebind.pipe(
  Layer.provide(makeAppDatabaseLayer({ appId: APP_ID_MEMORY, migrations: MEMORY_MIGRATIONS })),
);

/**
 * In-memory store for tests.
 *
 * `Layer.provide` rather than `provideMerge` on purpose: the app's `SqlClient`
 * must not leak into the surrounding context, or a test could accidentally assert
 * against it through the core tag and pass for the wrong reason.
 */
export const layerTest = rebind.pipe(Layer.provide(makeAppDatabaseMemoryLayer(MEMORY_MIGRATIONS)));
