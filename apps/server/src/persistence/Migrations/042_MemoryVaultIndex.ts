/**
 * 042_MemoryVaultIndex - Full-text search and wikilinks for the memory vault.
 *
 * Both tables are pure derived state over the markdown corpus, like the rest of
 * the memory index: dropping them and reindexing is a supported repair, not a
 * data loss. That is what lets the vault live in git or a sync folder.
 *
 * `memory_notes_fts` closes the gap that made "search" a misnomer -- the tool
 * filtered by tag and scope and never looked at a note's body. FTS5 is an
 * external-content-free virtual table here: the rows are written by the same
 * reindex path that writes `memory_notes`, so there is one place that can get
 * out of step rather than a trigger chain that can.
 *
 * `memory_note_wikilinks` is deliberately separate from `memory_note_links`.
 * Frontmatter links are explicit, curated, and carry a relation and a context
 * sentence; body wikilinks are what someone types mid-sentence and may not
 * resolve to anything at all. Merging them would mean either losing the
 * relation/context on curated links or inventing fake ones for wikilinks.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Contentless would save space but makes snippet extraction impossible, and
  // "why did this note match?" is most of what makes a search result useful.
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
      note_id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    )
  `;

  // `to_note_id` is nullable: an unresolved [[Wikilink]] is a normal state
  // meaning "a note worth writing later", exactly as it is in Obsidian. Storing
  // the row anyway is what lets the UI list unresolved links as work to do.
  //
  // `is_ambiguous` records that the title matched more than one note. The link
  // still resolves (to the most recently modified match) because refusing to
  // resolve would be less useful than resolving imperfectly, but the flag is
  // what lets the UI say so instead of silently picking.
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

  // Backlinks are the point of a Zettelkasten, so "which notes wikilink here?"
  // must be an indexed query rather than a scan of the corpus.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_note_wikilinks_target
    ON memory_note_wikilinks (to_note_id)
  `;

  // Resolving a title to an id happens once per wikilink on every reindex, so it
  // is the one lookup that has to stay indexed as the corpus grows.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_memory_notes_title
    ON memory_notes (title, modified_at DESC)
  `;
});
