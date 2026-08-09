/**
 * Vault-level tests: the properties that make the store Obsidian-like and the
 * index disposable. These are the acceptance criteria for the vault work, so
 * they are deliberately about observable behaviour rather than about the shape of
 * any one function.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as MemoryDb from "./MemoryDb.ts";
import {
  artifactSidecarPath,
  parseArtifactSidecar,
  reindexDrive,
  writeArtifact,
} from "./ArtifactStore.ts";
import {
  listNotes,
  reindexAll,
  reindexNoteFile,
  searchNotes,
  serializeNote,
  toFtsPhrase,
  unresolvedWikilinks,
  wikilinkBacklinksFor,
  writeNote,
  type MemoryNote,
} from "./NoteStore.ts";

// The memory app owns its store now, so tests run the app's migration
// sequence against an in-memory app database rather than core's.
const layer = it.layer(
  Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory(), MemoryDb.layerTest),
);

const note = (overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  id: "n_base",
  title: "Base note",
  status: "active",
  scope: "global",
  projectSegment: null,
  repositoryPath: null,
  tags: [],
  links: [],
  sources: [],
  created: "2026-08-01T00:00:00Z",
  modified: "2026-08-01T00:00:00Z",
  body: "Body text.",
  ...overrides,
});

const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-vault-" });
  const driveRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-drive-" });
  yield* reindexAll({ memoryRoot });
  yield* reindexDrive({ driveRoot });
  return { memoryRoot, driveRoot };
});

/** Drop a note file on disk without going through writeNote, as a hand edit would. */
const writeNoteFile = Effect.fn(function* (input: {
  readonly memoryRoot: string;
  readonly note: MemoryNote;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(input.memoryRoot, `${input.note.id}.md`),
    serializeNote(input.note),
  );
});

layer("full-text search", (it) => {
  // The gap that made "search" a misnomer: the old implementation filtered by
  // tag and scope and never looked at a body.
  it.effect("finds a note by a word only its body contains", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_body", title: "Unrelated title", body: "Uses pnpm for installs." }),
      });

      const byBody = yield* searchNotes({ query: "pnpm" });
      expect(byBody.map((row) => row.id)).toEqual(["n_body"]);

      // The same word is invisible to a tag listing, which is the point.
      const byTag = yield* listNotes({ tag: "pnpm" });
      expect(byTag).toEqual([]);
    }),
  );

  it("quotes the query so punctuation is searched, not parsed as syntax", () => {
    // Unquoted, each of these is FTS5 operator syntax and would be an error
    // rather than a search.
    expect(toFtsPhrase("foo-bar")).toBe('"foo-bar"');
    expect(toFtsPhrase('say "hi"')).toBe('"say ""hi"""');
  });

  it.effect("searches titles as well as bodies", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_title", title: "Guard migrations", body: "Nothing relevant." }),
      });

      expect((yield* searchNotes({ query: "migrations" })).map((row) => row.id)).toEqual([
        "n_title",
      ]);
    }),
  );

  it.effect("returns a snippet showing why the note matched", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_snip", body: "A long preamble, then the word marmalade appears." }),
      });

      const [row] = yield* searchNotes({ query: "marmalade" });
      expect(row?.snippet).toContain("marmalade");
    }),
  );

  // An accidental empty search box must not dump the corpus.
  it.effect("returns nothing for an empty query", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({ memoryRoot, note: note({ id: "n_any" }) });

      expect(yield* searchNotes({ query: "" })).toEqual([]);
      expect(yield* searchNotes({ query: "   " })).toEqual([]);
    }),
  );

  it.effect("drops a deleted note out of search", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { memoryRoot } = yield* setup();
      yield* writeNote({ memoryRoot, note: note({ id: "n_gone", body: "ephemeral content" }) });
      expect((yield* searchNotes({ query: "ephemeral" })).length).toBe(1);

      yield* fs.remove(path.join(memoryRoot, "n_gone.md"));
      yield* reindexNoteFile({ memoryRoot, fileName: "n_gone.md" });

      expect(yield* searchNotes({ query: "ephemeral" })).toEqual([]);
    }),
  );
});

layer("wikilinks", (it) => {
  // Resolution must not depend on the order files happen to be read, which is
  // why a full reindex resolves in a second pass.
  it.effect("resolves a link to a note that indexes later", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      // "a_" sorts before "z_", so the target is indexed after the source.
      yield* writeNoteFile({
        memoryRoot,
        note: note({ id: "a_source", title: "Source", body: "See [[Target Note]]." }),
      });
      yield* writeNoteFile({
        memoryRoot,
        note: note({ id: "z_target", title: "Target Note", body: "The target." }),
      });

      yield* reindexAll({ memoryRoot });

      const backlinks = yield* wikilinkBacklinksFor("z_target");
      expect(backlinks.map((row) => row.from_note_id)).toEqual(["a_source"]);
    }),
  );

  it.effect("keeps an unresolved link as the vault's to-do list", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_src", body: "Should write [[Something Missing]] up." }),
      });

      const unresolved = yield* unresolvedWikilinks({});
      expect(unresolved.map((row) => row.target_title)).toEqual(["Something Missing"]);
      expect(unresolved[0]?.reference_count).toBe(1);
    }),
  );

  it.effect("resolves an ambiguous title to the most recently modified note", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNoteFile({
        memoryRoot,
        note: note({ id: "n_old", title: "Notes", modified: "2026-08-01T00:00:00Z" }),
      });
      yield* writeNoteFile({
        memoryRoot,
        note: note({ id: "n_new", title: "Notes", modified: "2026-08-05T00:00:00Z" }),
      });
      yield* writeNoteFile({
        memoryRoot,
        note: note({ id: "n_src", title: "Source", body: "See [[Notes]]." }),
      });

      yield* reindexAll({ memoryRoot });

      const sql = yield* MemoryDb.MemoryDb;
      const rows = yield* sql<{
        readonly to_note_id: string | null;
        readonly is_ambiguous: number;
      }>`SELECT to_note_id, is_ambiguous FROM memory_note_wikilinks WHERE from_note_id = 'n_src'`;

      expect(rows[0]?.to_note_id).toBe("n_new");
      // Recorded rather than silently chosen, so the UI can say so.
      expect(rows[0]?.is_ambiguous).toBe(1);
    }),
  );

  // Without this the same vault answers "does this link resolve?" differently
  // depending on whether a full reindex has happened since. Obsidian resolves the
  // link when the note is created, and that is what people expect.
  it.effect("resolves a dangling link when its target note is created", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_src", title: "Source", body: "See [[Later Note]]." }),
      });
      expect((yield* unresolvedWikilinks({})).length).toBe(1);

      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_later", title: "Later Note", body: "Written afterwards." }),
      });

      expect(yield* unresolvedWikilinks({})).toEqual([]);
      expect((yield* wikilinkBacklinksFor("n_later")).map((row) => row.from_note_id)).toEqual([
        "n_src",
      ]);
    }),
  );

  it.effect("does not link a note to itself", () =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* setup();
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_self", title: "Self Ref", body: "About [[Self Ref]]." }),
      });

      expect(yield* wikilinkBacklinksFor("n_self")).toEqual([]);
    }),
  );
});

layer("the index is disposable", (it) => {
  // The claim the whole vault design rests on: back it up by copying the folder,
  // recover by deleting the index. If this fails, the index is the only copy of
  // something and none of that is true.
  it.effect("reproduces every note and artifact row after the index is dropped", () =>
    Effect.gen(function* () {
      const sql = yield* MemoryDb.MemoryDb;
      const { memoryRoot, driveRoot } = yield* setup();

      yield* writeNote({
        memoryRoot,
        note: note({
          id: "n_one",
          title: "First",
          tags: ["alpha"],
          body: "Links to [[Second]] and cites work.",
        }),
      });
      yield* writeNote({
        memoryRoot,
        note: note({ id: "n_two", title: "Second", body: "The second note." }),
      });
      yield* writeArtifact({
        driveRoot,
        projectSegment: "proj-abc123",
        relativePath: "reports/review.md",
        contents: "# Review\n",
        kind: "report",
        threadId: "th_7",
        turnId: "turn_3",
        checkpointRef: "abc1234",
        createdAt: "2026-08-02T00:00:00Z",
      });

      const readAll = Effect.gen(function* () {
        return {
          notes: yield* sql`SELECT * FROM memory_notes ORDER BY id`,
          wikilinks: yield* sql`SELECT * FROM memory_note_wikilinks ORDER BY from_note_id`,
          artifacts: yield* sql`SELECT * FROM drive_artifacts ORDER BY id`,
        };
      });

      const before = yield* readAll;

      // Drop everything an index holds, exactly as `rm state.sqlite` would.
      yield* sql`DELETE FROM memory_notes`;
      yield* sql`DELETE FROM memory_note_links`;
      yield* sql`DELETE FROM memory_note_sources`;
      yield* sql`DELETE FROM memory_note_wikilinks`;
      yield* sql`DELETE FROM memory_notes_fts`;
      yield* sql`DELETE FROM drive_artifacts`;

      yield* reindexAll({ memoryRoot });
      yield* reindexDrive({ driveRoot });

      expect(yield* readAll).toEqual(before);
      // And search still works, so the FTS rows came back too.
      expect((yield* searchNotes({ query: "second" })).length).toBeGreaterThan(0);
    }),
  );

  it.effect("writes an artifact's provenance beside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { driveRoot } = yield* setup();

      const written = yield* writeArtifact({
        driveRoot,
        projectSegment: "proj-abc123",
        relativePath: "out/notes.md",
        contents: "hello",
        kind: "export",
        threadId: "th_1",
        turnId: "turn_1",
        checkpointRef: "deadbee",
        createdAt: "2026-08-03T00:00:00Z",
      });

      const sidecar = parseArtifactSidecar(
        yield* fs.readFileString(artifactSidecarPath(written.absolutePath)),
      );

      // Everything the row holds, so nothing is lost with the database.
      expect(sidecar?.id).toBe(written.id);
      expect(sidecar?.thread_id).toBe("th_1");
      expect(sidecar?.turn_id).toBe("turn_1");
      expect(sidecar?.checkpoint_ref).toBe("deadbee");
      expect(sidecar?.kind).toBe("export");
      expect(sidecar?.content_sha256).toBe(written.contentSha256);
    }),
  );

  // Inventing provenance would be worse than omitting the row: the file is still
  // on disk and findable, but a fabricated created_at would never be corrected.
  it.effect("skips an artifact with no sidecar rather than inventing provenance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { driveRoot } = yield* setup();

      yield* fs.writeFileString(path.join(driveRoot, "orphan.md"), "no sidecar here");
      const result = yield* reindexDrive({ driveRoot });

      expect(result.indexed).toBe(0);
      expect(result.skipped.map((entry) => entry.reason)).toEqual(["no sidecar"]);
    }),
  );

  it.effect("does not index sidecars as artifacts in their own right", () =>
    Effect.gen(function* () {
      const { driveRoot } = yield* setup();
      yield* writeArtifact({
        driveRoot,
        projectSegment: null,
        relativePath: "solo.md",
        contents: "x",
        kind: "scratch",
        createdAt: "2026-08-04T00:00:00Z",
      });

      expect((yield* reindexDrive({ driveRoot })).indexed).toBe(1);
    }),
  );
});

describe("reindexNoteFile", () => {
  layer("incremental indexing", (it) => {
    // A hand edit must land without waiting for a consolidation run.
    it.effect("picks up a file written outside the app", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* writeNoteFile({
          memoryRoot,
          note: note({ id: "n_hand", title: "Hand edited", body: "typed directly on disk" }),
        });

        // Nothing knows about it yet.
        expect(yield* listNotes({})).toEqual([]);

        yield* reindexNoteFile({ memoryRoot, fileName: "n_hand.md" });

        expect((yield* listNotes({})).map((row) => row.id)).toEqual(["n_hand"]);
        expect((yield* searchNotes({ query: "directly" })).map((row) => row.id)).toEqual([
          "n_hand",
        ]);
      }),
    );

    // A half-written file from a sync tool is the common case. Dropping the note
    // on every partial write would make it flicker out of search while editing.
    it.effect("leaves a malformed file's existing rows in place", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { memoryRoot } = yield* setup();

        yield* writeNote({
          memoryRoot,
          note: note({ id: "n_partial", title: "Complete", body: "settled content" }),
        });

        yield* fs.writeFileString(path.join(memoryRoot, "n_partial.md"), "---\nid: n_par");
        const result = yield* reindexNoteFile({ memoryRoot, fileName: "n_partial.md" });

        expect(result.indexed).toBe(false);
        // Still searchable at its last good state.
        expect((yield* searchNotes({ query: "settled" })).map((row) => row.id)).toEqual([
          "n_partial",
        ]);
      }),
    );

    it.effect("is idempotent", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* writeNoteFile({
          memoryRoot,
          note: note({ id: "n_twice", title: "Twice", body: "Links [[Nowhere]]." }),
        });

        yield* reindexNoteFile({ memoryRoot, fileName: "n_twice.md" });
        const first = yield* listNotes({});
        const firstUnresolved = yield* unresolvedWikilinks({});

        yield* reindexNoteFile({ memoryRoot, fileName: "n_twice.md" });

        expect(yield* listNotes({})).toEqual(first);
        expect(yield* unresolvedWikilinks({})).toEqual(firstUnresolved);
      }),
    );
  });
});
