/**
 * MemoryRpc - Server handlers for the memory and drive RPC surface.
 *
 * These live here rather than inline in `ws.ts` for two reasons: the row-to-wire
 * mapping is real logic worth testing on its own, and `ws.ts` is already long
 * enough that adding five more handler bodies to it makes the file harder to
 * read than it already is.
 *
 * Every handler maps its failures to `MemoryOperationError`. The stores fail
 * with SQL and filesystem errors that mean nothing to a client and would leak
 * absolute paths into the UI if surfaced raw.
 *
 * @module MemoryRpc
 */
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";

import {
  MemoryOperationError,
  type MemoryConsolidateResult,
  type MemoryGetArtifactResult,
  type MemoryGetNoteResult,
  type MemoryListArtifactsResult,
  type MemoryListNotesResult,
  type MemoryReadDailyResult,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { getArtifact, listArtifacts, notesCiting, type ArtifactRecord } from "./ArtifactStore.ts";
import { parseDailyEntries, runConsolidation } from "./Consolidation.ts";
import { readDaily } from "./DailyStore.ts";
import { memoryRoots } from "./MemoryRoots.ts";
import {
  backlinksFor,
  listNotes,
  readNote,
  type NoteIndexRow,
  type NoteScope,
  type NoteStatus,
} from "./NoteStore.ts";

/** Wrap any store failure as the one error the wire contract admits. */
const asOperationError = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new MemoryOperationError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );

/**
 * Where the memory store lives for this server.
 *
 * Only the memory root is needed here: artifact reads go through the index
 * rather than the filesystem, so the drive root never enters these handlers.
 */
// Annotated rather than inferred: without it, inference collapses to `unknown`
// on both channels for every handler that yields this, which then fails the RPC
// group's context check with an error that names no real service.
const memoryRootFor: () => Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | ServerConfig | ServerSettingsService
> = () => Effect.map(memoryRoots(), (roots) => roots.memoryRoot);

/**
 * Tags parse defensively.
 *
 * The column holds a JSON array written by the note store, but a hand-edited
 * file can reach the index through reindex, and one malformed note must not
 * fail a whole list request.
 */
export function parseTags(raw: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

export function toNoteSummary(row: NoteIndexRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    scope: row.scope,
    projectSegment: row.project_segment,
    tags: parseTags(row.tags),
    modifiedAt: row.modified_at,
  };
}

export function toWireArtifact(record: ArtifactRecord) {
  return {
    id: record.id,
    relativePath: record.relative_path,
    projectSegment: record.project_segment,
    kind: record.kind,
    byteSize: record.byte_size,
    contentSha256: record.content_sha256,
    threadId: record.thread_id,
    turnId: record.turn_id,
    checkpointRef: record.checkpoint_ref,
    createdAt: record.created_at,
    archivedAt: record.archived_at,
  };
}

export const memoryConsolidate = Effect.fn("memory.rpc.consolidate")(function* () {
  const memoryRoot = yield* memoryRootFor();
  const outcome = yield* asOperationError("memory.consolidate", runConsolidation({ memoryRoot }));

  // Drop `summaryPath` on the way out: an absolute server path is not something
  // a client should render, and nothing in the UI needs it.
  return (
    outcome.kind === "completed"
      ? {
          kind: "completed",
          promoted: outcome.promoted,
          entriesRead: outcome.entriesRead,
          artifactsConsulted: outcome.artifactsConsulted,
        }
      : { kind: outcome.kind }
  ) satisfies MemoryConsolidateResult;
});

/**
 * Read the short-term capture buffer.
 *
 * Returns the raw text alongside the parsed entries: the text keeps redaction
 * markers exactly as written, and the entries save the client re-implementing
 * the provenance header format just to count or group them.
 */
export const memoryReadDaily = Effect.fn("memory.rpc.readDaily")(function* () {
  const memoryRoot = yield* memoryRootFor();
  const contents = yield* asOperationError("memory.readDaily", readDaily({ memoryRoot }));

  return {
    contents,
    entries: parseDailyEntries(contents).map((entry) => ({
      capturedAt: entry.capturedAt,
      projectSegment: entry.projectSegment,
      threadId: entry.threadId,
      body: entry.body,
    })),
  } satisfies MemoryReadDailyResult;
});

export const memoryListNotes = Effect.fn("memory.rpc.listNotes")(function* (input: {
  readonly scope?: string | undefined;
  readonly projectSegment?: string | undefined;
  readonly status?: string | undefined;
  readonly tag?: string | undefined;
  readonly limit?: number | undefined;
}) {
  const rows = yield* asOperationError(
    "memory.listNotes",
    listNotes({
      ...(input.scope !== undefined ? { scope: input.scope as NoteScope } : {}),
      ...(input.projectSegment !== undefined ? { projectSegment: input.projectSegment } : {}),
      ...(input.status !== undefined ? { status: input.status as NoteStatus } : {}),
      ...(input.tag !== undefined ? { tag: input.tag } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
  );

  return { notes: rows.map(toNoteSummary) } satisfies MemoryListNotesResult;
});

export const memoryGetNote = Effect.fn("memory.rpc.getNote")(function* (input: {
  readonly id: string;
}) {
  const memoryRoot = yield* memoryRootFor();

  // Both halves are fetched regardless of whether the note file exists: a note
  // row can outlive its file, and the backlinks are still worth showing.
  const note = yield* asOperationError("memory.getNote", readNote({ memoryRoot, id: input.id }));
  const backlinks = yield* asOperationError("memory.getNote", backlinksFor(input.id));

  return {
    note:
      note === null
        ? null
        : {
            id: note.id,
            title: note.title,
            status: note.status,
            scope: note.scope,
            projectSegment: note.projectSegment,
            repositoryPath: note.repositoryPath,
            tags: note.tags,
            links: note.links.map((link) => ({
              id: link.id,
              rel: link.rel,
              context: link.context ?? null,
            })),
            sources: note.sources.map((source) => ({
              artifactId: source.artifact,
              rel: source.rel,
              context: source.context ?? null,
            })),
            createdAt: note.created,
            modifiedAt: note.modified,
            body: note.body,
          },
    backlinks: backlinks.map((row) => ({
      noteId: row.from_note_id,
      title: row.title,
      rel: row.relation,
      context: row.context,
    })),
  } satisfies MemoryGetNoteResult;
});

export const memoryListArtifacts = Effect.fn("memory.rpc.listArtifacts")(function* (input: {
  readonly projectSegment?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
}) {
  const rows = yield* asOperationError(
    "memory.listArtifacts",
    listArtifacts({
      ...(input.projectSegment !== undefined ? { projectSegment: input.projectSegment } : {}),
      ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
  );

  return { artifacts: rows.map(toWireArtifact) } satisfies MemoryListArtifactsResult;
});

export const memoryGetArtifact = Effect.fn("memory.rpc.getArtifact")(function* (input: {
  readonly id: string;
}) {
  const record = yield* asOperationError("memory.getArtifact", getArtifact(input.id));
  const citing = yield* asOperationError("memory.getArtifact", notesCiting(input.id));

  return {
    artifact: record === null ? null : toWireArtifact(record),
    citingNotes: citing.map((row) => ({
      noteId: row.note_id,
      title: row.title,
      rel: row.relation,
      context: row.context,
    })),
  } satisfies MemoryGetArtifactResult;
});
