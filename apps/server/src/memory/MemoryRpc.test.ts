import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../config.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as MemoryDb from "./MemoryDb.ts";
import * as ServerSettings from "../serverSettings.ts";
import { writeArtifact } from "./ArtifactStore.ts";
import * as MemoryIndex from "./MemoryIndex.ts";
import { appendDailyEntry, clearDaily } from "./DailyStore.ts";
import {
  memoryConsolidate,
  memoryReadDaily,
  memoryGetArtifact,
  memoryGetNote,
  memoryListArtifacts,
  memoryListNotes,
  parseTags,
  toNoteSummary,
  toWireArtifact,
} from "./MemoryRpc.ts";
import { writeNote, type MemoryNote } from "./NoteStore.ts";

describe("wire mapping", () => {
  it("parses a tags column into an array", () => {
    expect(parseTags('["workflow","persistence"]')).toEqual(["workflow", "persistence"]);
    expect(parseTags("[]")).toEqual([]);
  });

  it("survives a malformed tags column rather than failing the list", () => {
    // Reachable in practice: reindex will index a hand-edited file.
    expect(parseTags("not json")).toEqual([]);
    expect(parseTags('{"not":"an array"}')).toEqual([]);
    expect(parseTags('["ok", 7, null]')).toEqual(["ok"]);
  });

  it("renames index columns to the wire shape", () => {
    const summary = toNoteSummary({
      id: "202608011200",
      title: "Guard migrations",
      status: "active",
      scope: "project",
      project_segment: "t3code-a41f2c",
      tags: '["workflow"]',
      modified_at: "2026-08-01T12:00:00Z",
    });

    expect(summary).toEqual({
      id: "202608011200",
      title: "Guard migrations",
      status: "active",
      scope: "project",
      projectSegment: "t3code-a41f2c",
      tags: ["workflow"],
      modifiedAt: "2026-08-01T12:00:00Z",
    });
  });

  it("renames artifact columns to the wire shape", () => {
    const artifact = toWireArtifact({
      id: "drv_1",
      relative_path: "t3code-a41f2c/2026-08-01/notes.md",
      project_segment: "t3code-a41f2c",
      kind: "report",
      byte_size: 12,
      content_sha256: "abc",
      thread_id: "th_1",
      turn_id: "turn_1",
      checkpoint_ref: null,
      created_at: "2026-08-01T12:00:00Z",
      archived_at: null,
    });

    expect(artifact.relativePath).toBe("t3code-a41f2c/2026-08-01/notes.md");
    expect(artifact.byteSize).toBe(12);
    expect(artifact.contentSha256).toBe("abc");
    expect(artifact.checkpointRef).toBeNull();
    // Storage-shaped keys must not leak onto the wire.
    expect(artifact).not.toHaveProperty("relative_path");
    expect(artifact).not.toHaveProperty("byte_size");
  });
});

// `ServerConfig.layerTest` reads the filesystem while it derives paths, so
// NodeServices has to be provided *to* it, not merged alongside it.
const layer = it.layer(
  // MemoryIndex is what consolidation now reindexes through, so that every
  // reindex path shares one lock.
  MemoryIndex.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-rpc-" }),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory(), MemoryDb.layerTest),
    ),
  ),
);

const setup = Effect.fn(function* () {
  const sql = yield* MemoryDb.MemoryDb;
  yield* sql`DELETE FROM drive_artifacts`;
  yield* sql`DELETE FROM memory_notes`;
  yield* sql`DELETE FROM memory_note_links`;
  yield* sql`DELETE FROM memory_note_sources`;

  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const fs = yield* FileSystem.FileSystem;
  // Resolution is the behaviour under test elsewhere; here just make sure the
  // resolved roots exist so handlers are exercised against a real directory.
  yield* fs.makeDirectory(config.memoryDir, { recursive: true });
  yield* fs.makeDirectory(config.driveDir, { recursive: true });
  // The layer derives one memory root for the whole file, so the buffer has to
  // be reset per test or captures leak between cases.
  yield* clearDaily({ memoryRoot: config.memoryDir });
  return { memoryRoot: config.memoryDir, driveRoot: config.driveDir, settings };
});

const noteFixture = (overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  id: "202608011200",
  title: "Guard migrations",
  status: "active",
  scope: "project",
  projectSegment: "t3code-a41f2c",
  repositoryPath: "/repos/t3code",
  tags: ["workflow"],
  links: [],
  sources: [],
  created: "2026-08-01T12:00:00Z",
  modified: "2026-08-01T12:00:00Z",
  body: "Lead with the guard.",
  ...overrides,
});

describe("read handlers", () => {
  layer((it) => {
    it.effect("lists notes as index rows without bodies", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* writeNote({ memoryRoot, note: noteFixture() });

        const result = yield* memoryListNotes({});

        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]?.title).toBe("Guard migrations");
        expect(result.notes[0]).not.toHaveProperty("body");
      }),
    );

    it.effect("filters notes by tag", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* writeNote({ memoryRoot, note: noteFixture() });
        yield* writeNote({
          memoryRoot,
          note: noteFixture({ id: "202608011300", tags: ["persistence"] }),
        });

        const result = yield* memoryListNotes({ tag: "persistence" });

        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]?.id).toBe("202608011300");
      }),
    );

    it.effect("returns a note with its links and sources in one round trip", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* writeNote({
          memoryRoot,
          note: noteFixture({
            links: [{ id: "202607290903", rel: "see-also", context: "Atomic writes." }],
            sources: [{ artifact: "drv_1", rel: "derived-from", context: "Review notes." }],
          }),
        });

        const result = yield* memoryGetNote({ id: "202608011200" });

        expect(result.note?.body).toBe("Lead with the guard.");
        expect(result.note?.links[0]?.context).toBe("Atomic writes.");
        // `artifact` becomes `artifactId` on the wire.
        expect(result.note?.sources[0]?.artifactId).toBe("drv_1");
      }),
    );

    it.effect("returns a null note rather than failing when the id is unknown", () =>
      Effect.gen(function* () {
        yield* setup();

        const result = yield* memoryGetNote({ id: "does-not-exist" });

        expect(result.note).toBeNull();
        expect(result.backlinks).toEqual([]);
      }),
    );

    it.effect("resolves provenance in both directions", () =>
      Effect.gen(function* () {
        const { memoryRoot, driveRoot } = yield* setup();
        const artifact = yield* writeArtifact({
          driveRoot,
          projectSegment: "t3code-a41f2c",
          relativePath: "report.md",
          contents: "findings",
          kind: "report",
          threadId: "th_1",
          turnId: "turn_1",
          checkpointRef: null,
          createdAt: "2026-08-01T12:00:00Z",
        });
        yield* writeNote({
          memoryRoot,
          note: noteFixture({
            sources: [{ artifact: artifact.id, rel: "derived-from", context: "The report." }],
          }),
        });

        // note -> artifact
        const note = yield* memoryGetNote({ id: "202608011200" });
        expect(note.note?.sources[0]?.artifactId).toBe(artifact.id);

        // artifact -> note
        const fetched = yield* memoryGetArtifact({ id: artifact.id });
        expect(fetched.artifact?.relativePath).toBe("t3code-a41f2c/report.md");
        expect(fetched.citingNotes[0]?.noteId).toBe("202608011200");
        expect(fetched.citingNotes[0]?.title).toBe("Guard migrations");
      }),
    );

    it.effect("returns a null artifact rather than failing when the id is unknown", () =>
      Effect.gen(function* () {
        yield* setup();

        const result = yield* memoryGetArtifact({ id: "drv_missing" });

        expect(result.artifact).toBeNull();
        expect(result.citingNotes).toEqual([]);
      }),
    );

    it.effect("lists artifacts newest first and hides archived ones by default", () =>
      Effect.gen(function* () {
        const { driveRoot } = yield* setup();
        yield* writeArtifact({
          driveRoot,
          projectSegment: "t3code-a41f2c",
          relativePath: "old.md",
          contents: "old",
          kind: "report",
          threadId: null,
          turnId: null,
          checkpointRef: null,
          createdAt: "2026-08-01T09:00:00Z",
        });
        yield* writeArtifact({
          driveRoot,
          projectSegment: "t3code-a41f2c",
          relativePath: "new.md",
          contents: "new",
          kind: "report",
          threadId: null,
          turnId: null,
          checkpointRef: null,
          createdAt: "2026-08-01T17:00:00Z",
        });

        const result = yield* memoryListArtifacts({});

        expect(result.artifacts.map((entry) => entry.relativePath)).toEqual([
          "t3code-a41f2c/new.md",
          "t3code-a41f2c/old.md",
        ]);
      }),
    );
  });
});

describe("daily handler", () => {
  layer((it) => {
    it.effect("returns an empty buffer without failing", () =>
      Effect.gen(function* () {
        yield* setup();

        const result = yield* memoryReadDaily();

        expect(result.entries).toEqual([]);
      }),
    );

    it.effect("parses provenance so the client need not know the header format", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* appendDailyEntry({
          memoryRoot,
          body: "Prefers guarded migrations.",
          provenance: {
            capturedAt: "2026-08-01T12:00:00Z",
            projectSegment: "t3code-a41f2c",
            threadId: "th_1",
          },
        });

        const result = yield* memoryReadDaily();

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.projectSegment).toBe("t3code-a41f2c");
        expect(result.entries[0]?.threadId).toBe("th_1");
        expect(result.entries[0]?.body).toContain("Prefers guarded migrations.");
        // The raw text ships too, so the UI can show exactly what is on disk.
        expect(result.contents).toContain("t3code-a41f2c");
      }),
    );

    it.effect("shows the redaction marker and never the secret", () =>
      Effect.gen(function* () {
        const { memoryRoot } = yield* setup();
        yield* appendDailyEntry({
          memoryRoot,
          body: `token ghp_${"x".repeat(36)} here`,
          provenance: {
            capturedAt: "2026-08-01T12:00:00Z",
            projectSegment: null,
            threadId: "th_1",
          },
        });

        const result = yield* memoryReadDaily();

        expect(result.contents).toContain("[redacted:");
        expect(result.contents).not.toContain("ghp_xxxx");
        // A capture with no resolvable project is still readable.
        expect(result.entries[0]?.projectSegment).toBeNull();
      }),
    );
  });
});

describe("consolidate handler", () => {
  layer((it) => {
    it.effect("reports nothing-to-do without inventing counts", () =>
      Effect.gen(function* () {
        yield* setup();

        const result = yield* memoryConsolidate();

        // The tagged union is what keeps a client from reading counts that
        // aren't there; assert the tag rather than the absence of fields.
        expect(result.kind).toBe("nothing-to-do");
        expect(result).not.toHaveProperty("promoted");
      }),
    );

    it.effect("never returns a server path to the client", () =>
      Effect.gen(function* () {
        yield* setup();

        const result = yield* memoryConsolidate();

        expect(result).not.toHaveProperty("summaryPath");
      }),
    );
  });
});
