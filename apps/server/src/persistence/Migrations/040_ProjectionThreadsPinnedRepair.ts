import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases that skipped 036_ProjectionThreadsPinned.
 *
 * This fork carried its own 036 (MemoryAndDrive) before syncing the upstream
 * commits that claimed 036-038. The sync renumbered ours to 039, but the
 * migrator skips by id alone -- `if (currentId <= latestMigrationId) continue`
 * -- with no check that the recorded name matches. So any database that had
 * already applied the fork's 036 reported a latest id of 36 and silently
 * skipped upstream's 036, landing in a state with `pin_order_key` (from 038)
 * but no `pinned_at`: every pinned-thread read fails.
 *
 * Re-running the same guarded ALTER at a fresh id is the repair. It is a no-op
 * on databases where 036 did run, so this is safe for every install regardless
 * of which side of the renumber it was created on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "pinned_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_at TEXT
    `;
  }
});
