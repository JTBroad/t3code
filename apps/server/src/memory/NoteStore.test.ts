import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as MemoryDb from "./MemoryDb.ts";
import {
  backlinksFor,
  listNotes,
  type MemoryNote,
  parseNote,
  readNote,
  reindexAll,
  serializeNote,
  writeNote,
} from "./NoteStore.ts";

// The memory app owns its store now, so tests run the app's migration
// sequence against an in-memory app database rather than core's.
const layer = it.layer(
  Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory(), MemoryDb.layerTest),
);

const note = (overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  id: "202608011412",
  title: "Prefers migrations guarded, never assumed idempotent",
  status: "active",
  scope: "global",
  projectSegment: null,
  repositoryPath: null,
  tags: ["workflow", "persistence"],
  links: [],
  sources: [],
  created: "2026-08-01T14:12:00Z",
  modified: "2026-08-01T14:12:00Z",
  body: "Migrations are reviewed for idempotency before landing.\n\nBehavioral effect: lead with the guard.",
  ...overrides,
});

/**
 * Fresh temp memory root with the schema migrated.
 *
 * `it.layer` hands every test in a suite the same in-memory database, so the
 * index is cleared here too -- reindexing the new empty root does exactly that.
 */
const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const memoryRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-notes-" });
  yield* reindexAll({ memoryRoot });
  return memoryRoot;
});

describe("note serialization", () => {
  it("round-trips a note through markdown", () => {
    const original = note({
      links: [{ id: "202607290903", rel: "see-also", context: "The atomic-write convention." }],
      sources: [{ artifact: "drv_01", rel: "derived-from", context: "Migration review notes." }],
    });

    const parsed = parseNote(serializeNote(original));
    assert.ok(parsed.kind === "parsed");
    expect(parsed.note).toEqual(original);
    // The two fields that make a link readable a year later.
    expect(parsed.note.links[0]?.rel).toBe("see-also");
    expect(parsed.note.links[0]?.context).toBe("The atomic-write convention.");
  });

  it("reports malformed input instead of throwing", () => {
    expect(parseNote("no frontmatter here").kind).toBe("malformed");
    expect(parseNote("---\n: : bad yaml :\n---\nbody").kind).toBe("malformed");
    expect(parseNote("---\ntitle: no id\n---\nbody").kind).toBe("malformed");
  });
});

layer("note store", (it) => {
  it.effect("writes a note to disk and indexes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* writeNote({ memoryRoot, note: note() });

        const readBack = yield* readNote({ memoryRoot, id: "202608011412" });
        expect(readBack?.title).toBe("Prefers migrations guarded, never assumed idempotent");

        const rows = yield* listNotes({});
        expect(rows.map((row) => row.id)).toEqual(["202608011412"]);
      }),
    ),
  );

  it.effect("resolves backlinks from the index", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* writeNote({ memoryRoot, note: note({ id: "target" }) });
        yield* writeNote({
          memoryRoot,
          note: note({
            id: "source",
            links: [{ id: "target", rel: "refines", context: "Extends the guard rule." }],
          }),
        });

        const backlinks = yield* backlinksFor("target");
        expect(backlinks.map((row) => row.from_note_id)).toEqual(["source"]);
        expect(backlinks[0]?.relation).toBe("refines");
        expect(backlinks[0]?.context).toBe("Extends the guard rule.");
      }),
    ),
  );

  it.effect("drops a link from the index once it leaves the file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* writeNote({
          memoryRoot,
          note: note({ id: "source", links: [{ id: "target", rel: "see-also" }] }),
        });
        expect((yield* backlinksFor("target")).length).toBe(1);

        yield* writeNote({ memoryRoot, note: note({ id: "source", links: [] }) });
        expect((yield* backlinksFor("target")).length).toBe(0);
      }),
    ),
  );

  it.effect("filters by scope, status, and tag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        yield* writeNote({ memoryRoot, note: note({ id: "g1", tags: ["workflow"] }) });
        yield* writeNote({
          memoryRoot,
          note: note({ id: "p1", scope: "project", projectSegment: "api-3f9c01", tags: ["build"] }),
        });
        yield* writeNote({ memoryRoot, note: note({ id: "d1", status: "demoted", tags: [] }) });

        expect((yield* listNotes({ scope: "project" })).map((row) => row.id)).toEqual(["p1"]);
        expect((yield* listNotes({ status: "demoted" })).map((row) => row.id)).toEqual(["d1"]);
        expect((yield* listNotes({ tag: "workflow" })).map((row) => row.id)).toEqual(["g1"]);
      }),
    ),
  );

  it.effect("ranks the current project ahead of global notes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* setup();
        // Global note is newer, so only project-first ordering puts p1 on top.
        yield* writeNote({
          memoryRoot,
          note: note({
            id: "p1",
            scope: "project",
            projectSegment: "api-3f9c01",
            modified: "2026-08-01T10:00:00Z",
          }),
        });
        yield* writeNote({
          memoryRoot,
          note: note({ id: "g1", modified: "2026-08-01T23:00:00Z" }),
        });

        const rows = yield* listNotes({ projectSegment: "api-3f9c01" });
        expect(rows[0]?.id).toBe("p1");
      }),
    ),
  );
});

layer("reindex", (it) => {
  it.effect("repairs the index after a file is edited outside the app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* setup();

        yield* writeNote({ memoryRoot, note: note({ id: "n1", title: "Original" }) });
        yield* fs.writeFileString(
          path.join(memoryRoot, "n1.md"),
          serializeNote(note({ id: "n1", title: "Edited by hand" })),
        );

        const result = yield* reindexAll({ memoryRoot });
        expect(result.indexed).toBe(1);
        expect((yield* listNotes({}))[0]?.title).toBe("Edited by hand");
      }),
    ),
  );

  it.effect("skips a malformed file and still indexes the healthy ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* setup();

        yield* writeNote({ memoryRoot, note: note({ id: "good" }) });
        yield* fs.writeFileString(path.join(memoryRoot, "broken.md"), "not a note at all");

        const result = yield* reindexAll({ memoryRoot });
        expect(result.indexed).toBe(1);
        expect(result.skipped.map((entry) => entry.file)).toEqual(["broken.md"]);
        expect((yield* listNotes({})).map((row) => row.id)).toEqual(["good"]);
      }),
    ),
  );

  // The buffer and rotated buffers are consolidation's own working files.
  // Indexing them would be the cycle consuming its own output.
  it.effect("ignores the daily buffer, rotated buffers, and the index file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* setup();

        yield* writeNote({ memoryRoot, note: note({ id: "real" }) });
        yield* fs.writeFileString(path.join(memoryRoot, "daily.md"), "## capture\nobservation\n");
        yield* fs.writeFileString(
          path.join(memoryRoot, "daily.2026-08-01T13-00-00Z.pending.md"),
          "## capture\nrotated observation\n",
        );
        yield* fs.writeFileString(path.join(memoryRoot, "_index.md"), "# Themes\n");

        const result = yield* reindexAll({ memoryRoot });
        expect(result.indexed).toBe(1);
        expect(result.skipped).toEqual([]);
        expect((yield* listNotes({})).map((row) => row.id)).toEqual(["real"]);
      }),
    ),
  );

  it.effect("removes index rows for notes deleted on disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* setup();

        yield* writeNote({ memoryRoot, note: note({ id: "gone" }) });
        yield* fs.remove(path.join(memoryRoot, "gone.md"));

        yield* reindexAll({ memoryRoot });
        expect(yield* listNotes({})).toEqual([]);
      }),
    ),
  );
});
