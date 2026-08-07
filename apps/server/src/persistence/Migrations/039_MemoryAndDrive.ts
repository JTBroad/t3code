/**
 * 039_MemoryAndDrive - Index tables for the shared memory and drive stores.
 *
 * These are deliberately not `projection_*` tables. Projections are derived
 * from the orchestration event log and can be rebuilt by replay; memory notes
 * and drive artifacts are primary, user-owned state that nothing replays. The
 * markdown files on disk remain the source of truth for notes -- these rows are
 * an index so recall and backlink queries do not scan the corpus, and are
 * rebuilt from frontmatter by the consolidation reindex pass.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per file written under the drive root.
  yield* sql`
    CREATE TABLE IF NOT EXISTS drive_artifacts (
      id                TEXT PRIMARY KEY,
      relative_path     TEXT NOT NULL,
      project_segment   TEXT,
      repository_path   TEXT,
      thread_id         TEXT,
      turn_id           TEXT,
      checkpoint_ref    TEXT,
      kind              TEXT NOT NULL,
      byte_size         INTEGER NOT NULL,
      content_sha256    TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      archived_at       TEXT
    )
  `;

  // One row per permanent note. The markdown file stays authoritative.
  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_notes (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      status            TEXT NOT NULL,
      scope             TEXT NOT NULL,
      project_segment   TEXT,
      repository_path   TEXT,
      tags              TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      modified_at       TEXT NOT NULL
    )
  `;

  // Which artifacts produced which note. Answers "why does the agent believe
  // this?" from the note side, and "what did this produce?" from the artifact
  // side.
  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_note_sources (
      note_id           TEXT NOT NULL,
      artifact_id       TEXT NOT NULL,
      relation          TEXT NOT NULL,
      context           TEXT,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (note_id, artifact_id)
    )
  `;

  // Note-to-note links, mirrored from frontmatter. Backlinks are the point of a
  // Zettelkasten, so "which notes link here?" must be an indexed query.
  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_note_links (
      from_note_id      TEXT NOT NULL,
      to_note_id        TEXT NOT NULL,
      relation          TEXT NOT NULL,
      context           TEXT,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (from_note_id, to_note_id)
    )
  `;

  // A live artifact path is unique, but archiving releases it. Re-running the
  // same task is the normal case, and it should be able to reuse a natural
  // filename once the previous run is archived.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_artifacts_live_path
    ON drive_artifacts (relative_path) WHERE archived_at IS NULL
  `;

  // Recall is always "this project first, then global".
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_memory_notes_scope
    ON memory_notes (scope, project_segment, modified_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_drive_artifacts_project
    ON drive_artifacts (project_segment, created_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_drive_artifacts_thread
    ON drive_artifacts (thread_id, turn_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_note_sources_artifact
    ON memory_note_sources (artifact_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_note_links_backlinks
    ON memory_note_links (to_note_id)
  `;
});
