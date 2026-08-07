import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The explicit thread↔PR link, stored as one JSON blob rather than a column
 * per field: nothing queries into it (the projection only ever reads the whole
 * link back out), and the shape is expected to grow — review state, checks —
 * without a migration each time.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "linked_pull_request")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linked_pull_request TEXT
    `;
  }
});
