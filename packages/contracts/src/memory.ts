/**
 * Memory - Schemas for the shared Zettelkasten and drive surfaces.
 *
 * Wire shapes are camelCase even though the underlying tables are snake_case:
 * the row shape is a storage detail, and leaking it would make every client
 * field name a hostage to a future migration.
 *
 * List responses carry a bounded limit by construction. A corpus of a few
 * thousand notes returned in one response visibly stalls the UI, and adding a
 * cap after clients depend on getting everything is a breaking change.
 *
 * @module Memory
 */
import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MEMORY_LIST_DEFAULT_LIMIT = 100;
export const MEMORY_LIST_MAX_LIMIT = 500;

const MemoryListLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MEMORY_LIST_MAX_LIMIT }),
);

export const MemoryNoteId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type MemoryNoteId = typeof MemoryNoteId.Type;

export const DriveArtifactId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type DriveArtifactId = typeof DriveArtifactId.Type;

export const MemoryNoteStatus = Schema.Literals(["active", "demoted", "archived"]);
export type MemoryNoteStatus = typeof MemoryNoteStatus.Type;

export const MemoryNoteScope = Schema.Literals(["global", "project"]);
export type MemoryNoteScope = typeof MemoryNoteScope.Type;

/* ── consolidation ──────────────────────────────────────────────────────── */

/**
 * The outcome of a consolidation run.
 *
 * A tagged union rather than a nullable count: "already running" is a normal
 * outcome of pressing the button twice, not a failure, and a client that models
 * it as one shows an error toast for something that went fine. The tag makes it
 * impossible to read the counts without first handling the other cases.
 */
export const MemoryConsolidateResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("completed"),
    promoted: NonNegativeInt,
    entriesRead: NonNegativeInt,
    artifactsConsulted: NonNegativeInt,
  }),
  Schema.Struct({ kind: Schema.Literal("already-running") }),
  Schema.Struct({ kind: Schema.Literal("nothing-to-do") }),
]);
export type MemoryConsolidateResult = typeof MemoryConsolidateResult.Type;

export const MemoryConsolidateInput = Schema.Struct({});
export type MemoryConsolidateInput = typeof MemoryConsolidateInput.Type;

/* ── notes ──────────────────────────────────────────────────────────────── */

export const MemoryNoteLink = Schema.Struct({
  id: Schema.String,
  rel: Schema.String,
  context: Schema.NullOr(Schema.String),
});
export type MemoryNoteLink = typeof MemoryNoteLink.Type;

export const MemoryNoteSource = Schema.Struct({
  artifactId: Schema.String,
  rel: Schema.String,
  context: Schema.NullOr(Schema.String),
});
export type MemoryNoteSource = typeof MemoryNoteSource.Type;

/** A note as it appears in a list: index columns only, never the body. */
export const MemoryNoteSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.String,
  scope: Schema.String,
  projectSegment: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  modifiedAt: Schema.String,
});
export type MemoryNoteSummary = typeof MemoryNoteSummary.Type;

export const MemoryBacklink = Schema.Struct({
  noteId: Schema.String,
  title: Schema.NullOr(Schema.String),
  rel: Schema.String,
  context: Schema.NullOr(Schema.String),
});
export type MemoryBacklink = typeof MemoryBacklink.Type;

export const MemoryListNotesInput = Schema.Struct({
  scope: Schema.optionalKey(MemoryNoteScope),
  projectSegment: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(MemoryNoteStatus),
  tag: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(MemoryListLimit),
});
export type MemoryListNotesInput = typeof MemoryListNotesInput.Type;

export const MemoryListNotesResult = Schema.Struct({
  notes: Schema.Array(MemoryNoteSummary),
});
export type MemoryListNotesResult = typeof MemoryListNotesResult.Type;

export const MemoryGetNoteInput = Schema.Struct({ id: MemoryNoteId });
export type MemoryGetNoteInput = typeof MemoryGetNoteInput.Type;

/**
 * A note and everything the detail pane needs, in one round trip.
 *
 * Backlinks and cited artifacts are included deliberately rather than left to
 * follow-up calls: splitting them turns opening a note into a request waterfall
 * for data that is always displayed together.
 */
export const MemoryGetNoteResult = Schema.Struct({
  note: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      status: Schema.String,
      scope: Schema.String,
      projectSegment: Schema.NullOr(Schema.String),
      repositoryPath: Schema.NullOr(Schema.String),
      tags: Schema.Array(Schema.String),
      links: Schema.Array(MemoryNoteLink),
      sources: Schema.Array(MemoryNoteSource),
      createdAt: Schema.String,
      modifiedAt: Schema.String,
      body: Schema.String,
    }),
  ),
  backlinks: Schema.Array(MemoryBacklink),
});
export type MemoryGetNoteResult = typeof MemoryGetNoteResult.Type;

/* ── artifacts ──────────────────────────────────────────────────────────── */

export const DriveArtifact = Schema.Struct({
  id: Schema.String,
  relativePath: Schema.String,
  projectSegment: Schema.NullOr(Schema.String),
  kind: Schema.String,
  byteSize: NonNegativeInt,
  contentSha256: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  checkpointRef: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});
export type DriveArtifact = typeof DriveArtifact.Type;

export const MemoryListArtifactsInput = Schema.Struct({
  projectSegment: Schema.optionalKey(Schema.String),
  includeArchived: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(MemoryListLimit),
});
export type MemoryListArtifactsInput = typeof MemoryListArtifactsInput.Type;

export const MemoryListArtifactsResult = Schema.Struct({
  artifacts: Schema.Array(DriveArtifact),
});
export type MemoryListArtifactsResult = typeof MemoryListArtifactsResult.Type;

export const MemoryGetArtifactInput = Schema.Struct({ id: DriveArtifactId });
export type MemoryGetArtifactInput = typeof MemoryGetArtifactInput.Type;

/** Metadata plus the notes citing it -- the other direction of provenance. */
export const MemoryGetArtifactResult = Schema.Struct({
  artifact: Schema.NullOr(DriveArtifact),
  citingNotes: Schema.Array(
    Schema.Struct({
      noteId: Schema.String,
      title: Schema.NullOr(Schema.String),
      rel: Schema.String,
      context: Schema.NullOr(Schema.String),
    }),
  ),
});
export type MemoryGetArtifactResult = typeof MemoryGetArtifactResult.Type;

/* ── errors ─────────────────────────────────────────────────────────────── */

/**
 * A memory operation could not complete.
 *
 * One error for the whole surface: from a client's perspective the recoveries
 * are identical (surface the message, leave the view as it was), so splitting
 * per operation would add cases nobody switches on.
 */
export class MemoryOperationError extends Schema.ErrorClass<MemoryOperationError>(
  "MemoryOperationError",
)({
  _tag: Schema.tag("MemoryOperationError"),
  operation: Schema.String,
  message: Schema.String,
}) {}
