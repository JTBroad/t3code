/**
 * 001_MemoryVault - The memory app's whole schema, in the app's own database.
 *
 * This is the union of what core migrations 039 and 042 used to create, moved
 * into `<stateDir>/apps/memory/state.sqlite` and renumbered from 001. Those two
 * are now tombstones in the core sequence: their ids stay so already-migrated
 * databases keep their place, but they create nothing.
 *
 * No row copy-forward accompanies the move. Every table here is derived state
 * over files on disk -- note frontmatter and drive sidecars -- so the new store
 * is populated by reindexing rather than by migrating rows out of the old one.
 * That is the payoff for making the store rebuildable first.
 *
 * The one thing that is not derivable is provenance for artifacts written before
 * sidecars existed; `MemoryLegacyImport` backfills those sidecars from the old
 * table so this reindex has something to read.
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

  // Curated note-to-note links, mirrored from frontmatter. Backlinks are the
  // point of a Zettelkasten, so "which notes link here?" must be indexed.
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

  // Body `[[Title]]` references. Separate from the curated links above: those
  // carry a relation and a context sentence and always resolve; these name a
  // title, may resolve to nothing, and may be ambiguous.
  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_note_wikilinks (
      from_note_id      TEXT NOT NULL,
      target_title      TEXT NOT NULL,
      to_note_id        TEXT,
      is_ambiguous      INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (from_note_id, target_title)
    )
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
      note_id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
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
    CREATE INDEX IF NOT EXISTS idx_memory_notes_title
    ON memory_notes (title, modified_at DESC)
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
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_note_wikilinks_target
    ON memory_note_wikilinks (to_note_id)
  `;
});
