/**
 * ArtifactStore - Generated files that should not be committed to any project.
 *
 * The value here is not the file browser -- worktrees and diff views already
 * beat that. It is that an artifact becomes *addressable*: a stable id,
 * provenance back to the thread and turn that produced it, and a place in the
 * corpus that a consolidation run can cite. Observations say what happened;
 * artifacts say what was actually done.
 *
 * Every write passes through the containment guard, and a path that escapes the
 * configured drive root is refused outright rather than clamped.
 *
 * @module ArtifactStore
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { resolveWithinRoot } from "./MemoryPaths.ts";

export class ArtifactPathRejectedError extends Error {
  readonly _tag = "ArtifactPathRejectedError";
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`Artifact path escapes the drive root: ${relativePath}`);
    this.relativePath = relativePath;
  }
}

export interface WriteArtifactInput {
  readonly driveRoot: string;
  /** Bucket for the originating project, or null when unattributable. */
  readonly projectSegment: string | null;
  /** Path within the project bucket, e.g. `2026-08-01/review-notes.md`. */
  readonly relativePath: string;
  readonly contents: string;
  readonly kind: string;
  readonly repositoryPath?: string | null | undefined;
  readonly threadId?: string | null | undefined;
  readonly turnId?: string | null | undefined;
  /** Links the artifact to a real diff, which beats prose as evidence. */
  readonly checkpointRef?: string | null | undefined;
  readonly createdAt: string;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly relative_path: string;
  readonly project_segment: string | null;
  readonly kind: string;
  readonly byte_size: number;
  readonly content_sha256: string;
  readonly thread_id: string | null;
  readonly turn_id: string | null;
  readonly checkpoint_ref: string | null;
  readonly created_at: string;
  readonly archived_at: string | null;
}

const DEFAULT_LIST_LIMIT = 100;

/**
 * Suffix of the sidecar carrying an artifact's provenance.
 *
 * The drive half of the store used to keep provenance -- thread, turn,
 * checkpoint, kind -- only in its index row, which meant losing the database
 * turned a drive full of artifacts into a directory of anonymous files. Notes
 * never had that problem because their frontmatter is on disk with them.
 *
 * A sidecar restores the same property: everything the index holds is
 * reconstructible by walking the folder. That is what makes "back it up by
 * copying the folder" and "recover by deleting the index and reindexing" true
 * for the whole app rather than half of it.
 */
export const ARTIFACT_SIDECAR_SUFFIX = ".meta.json";

/** Whether a drive file is a sidecar rather than an artifact. */
export function isArtifactSidecar(fileName: string): boolean {
  return fileName.endsWith(ARTIFACT_SIDECAR_SUFFIX);
}

export function artifactSidecarPath(absolutePath: string): string {
  return `${absolutePath}${ARTIFACT_SIDECAR_SUFFIX}`;
}

/**
 * An artifact's provenance as written beside it.
 *
 * Field names match the index columns so the mapping in either direction is
 * mechanical -- a sidecar that drifted from the row shape would be worse than no
 * sidecar, because reindex would silently produce different rows.
 */
export interface ArtifactSidecar {
  readonly id: string;
  readonly relative_path: string;
  readonly project_segment: string | null;
  readonly repository_path: string | null;
  readonly thread_id: string | null;
  readonly turn_id: string | null;
  readonly checkpoint_ref: string | null;
  readonly kind: string;
  readonly byte_size: number;
  readonly content_sha256: string;
  readonly created_at: string;
  readonly archived_at: string | null;
}

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Parse a sidecar, tolerating anything that is not one.
 *
 * Returns null rather than failing: a hand-edited or half-written sidecar must
 * not abort a reindex of the whole drive, exactly as a malformed note does not
 * abort a reindex of the vault.
 */
export function parseArtifactSidecar(contents: string): ArtifactSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const id = asNullableString(record.id);
  const relativePath = asNullableString(record.relative_path);
  const contentSha256 = asNullableString(record.content_sha256);
  const createdAt = asNullableString(record.created_at);
  if (!id || !relativePath || !contentSha256 || !createdAt) {
    return null;
  }

  return {
    id,
    relative_path: relativePath,
    project_segment: asNullableString(record.project_segment),
    repository_path: asNullableString(record.repository_path),
    thread_id: asNullableString(record.thread_id),
    turn_id: asNullableString(record.turn_id),
    checkpoint_ref: asNullableString(record.checkpoint_ref),
    kind: asNullableString(record.kind) ?? "scratch",
    byte_size: typeof record.byte_size === "number" ? record.byte_size : 0,
    content_sha256: contentSha256,
    created_at: createdAt,
    archived_at: asNullableString(record.archived_at),
  };
}

export function serializeArtifactSidecar(sidecar: ArtifactSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

/** Path inside the drive root, namespaced by project so files stay attributable. */
export function artifactRelativePath(input: {
  readonly projectSegment: string | null;
  readonly relativePath: string;
}): string {
  return input.projectSegment
    ? `${input.projectSegment}/${input.relativePath}`
    : input.relativePath;
}

/**
 * Write an artifact and index it.
 *
 * Fails without touching disk or the database when the path escapes the root:
 * a partial write plus no row would leave an unreferenced file behind.
 */
export const writeArtifact = Effect.fn("memory.writeArtifact")(function* (
  input: WriteArtifactInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;

  const relativePath = artifactRelativePath(input);
  const absolutePath = resolveWithinRoot({ root: input.driveRoot, relativePath });
  if (!absolutePath) {
    return yield* Effect.fail(new ArtifactPathRejectedError(relativePath));
  }

  const id = `drv_${NodeCrypto.randomUUID()}`;
  const contentSha256 = NodeCrypto.createHash("sha256").update(input.contents).digest("hex");
  const byteSize = Buffer.byteLength(input.contents, "utf8");

  const sidecar: ArtifactSidecar = {
    id,
    relative_path: relativePath,
    project_segment: input.projectSegment,
    repository_path: input.repositoryPath ?? null,
    thread_id: input.threadId ?? null,
    turn_id: input.turnId ?? null,
    checkpoint_ref: input.checkpointRef ?? null,
    kind: input.kind,
    byte_size: byteSize,
    content_sha256: contentSha256,
    created_at: input.createdAt,
    archived_at: null,
  };

  yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* writeFileStringAtomically({ filePath: absolutePath, contents: input.contents });
  // Sidecar before the row, for the same reason notes are written file-first: a
  // file with no row is repaired by the next reindex, while a row with no file is
  // a dangling reference nothing repairs.
  yield* writeFileStringAtomically({
    filePath: artifactSidecarPath(absolutePath),
    contents: serializeArtifactSidecar(sidecar),
  });

  yield* sql`
    INSERT INTO drive_artifacts
      (id, relative_path, project_segment, repository_path, thread_id, turn_id,
       checkpoint_ref, kind, byte_size, content_sha256, created_at, archived_at)
    VALUES
      (${id}, ${relativePath}, ${input.projectSegment}, ${input.repositoryPath ?? null},
       ${input.threadId ?? null}, ${input.turnId ?? null}, ${input.checkpointRef ?? null},
       ${input.kind}, ${byteSize}, ${contentSha256}, ${input.createdAt}, ${null})
  `;

  return { id, relativePath, absolutePath, contentSha256, byteSize };
});

export interface DriveReindexResult {
  readonly indexed: number;
  readonly skipped: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

/**
 * Rebuild the drive index by walking the drive root.
 *
 * The counterpart to the vault's `reindexAll`, and what makes the whole app store
 * derivable: with this, deleting the database and reindexing restores every row,
 * so the index is a cache rather than the only copy of the provenance.
 *
 * An artifact whose sidecar is missing or unreadable is skipped rather than
 * indexed with invented provenance. A row claiming an artifact came from nowhere
 * is worse than no row: the file is still on disk and still findable, but nothing
 * would ever correct a fabricated `created_at`.
 */
export const reindexDrive = Effect.fn("memory.reindexDrive")(function* (input: {
  readonly driveRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* fs.exists(input.driveRoot))) {
    return { indexed: 0, skipped: [] } satisfies DriveReindexResult;
  }

  // Rebuilt from scratch so artifacts deleted on disk leave the index too.
  yield* sql`DELETE FROM drive_artifacts`;

  const skipped: Array<{ file: string; reason: string }> = [];
  let indexed = 0;

  const walk = (directory: string): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(directory);
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry);
        const info = yield* fs.stat(absolutePath);
        if (info.type === "Directory") {
          yield* walk(absolutePath);
          continue;
        }
        if (isArtifactSidecar(entry)) {
          continue;
        }

        const sidecarPath = artifactSidecarPath(absolutePath);
        if (!(yield* fs.exists(sidecarPath))) {
          skipped.push({ file: entry, reason: "no sidecar" });
          continue;
        }

        const sidecar = parseArtifactSidecar(yield* fs.readFileString(sidecarPath));
        if (sidecar === null) {
          skipped.push({ file: entry, reason: "unreadable sidecar" });
          continue;
        }

        yield* sql`
          INSERT INTO drive_artifacts
            (id, relative_path, project_segment, repository_path, thread_id, turn_id,
             checkpoint_ref, kind, byte_size, content_sha256, created_at, archived_at)
          VALUES
            (${sidecar.id}, ${sidecar.relative_path}, ${sidecar.project_segment},
             ${sidecar.repository_path}, ${sidecar.thread_id}, ${sidecar.turn_id},
             ${sidecar.checkpoint_ref}, ${sidecar.kind}, ${sidecar.byte_size},
             ${sidecar.content_sha256}, ${sidecar.created_at}, ${sidecar.archived_at})
          ON CONFLICT(id) DO NOTHING
        `;
        indexed += 1;
      }
    }).pipe(Effect.orDie);

  yield* walk(input.driveRoot);
  return { indexed, skipped } satisfies DriveReindexResult;
});

/** Artifacts for a project (or all projects), newest first. */
export const listArtifacts = Effect.fn("memory.listArtifacts")(function* (input: {
  readonly projectSegment?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const projectSegment = input.projectSegment ?? null;
  const includeArchived = input.includeArchived === true ? 1 : 0;

  return yield* sql<ArtifactRecord>`
    SELECT id, relative_path, project_segment, kind, byte_size, content_sha256,
           thread_id, turn_id, checkpoint_ref, created_at, archived_at
    FROM drive_artifacts
    WHERE (${projectSegment} IS NULL OR project_segment = ${projectSegment})
      AND (${includeArchived} = 1 OR archived_at IS NULL)
    ORDER BY created_at DESC, id DESC
    LIMIT ${input.limit ?? DEFAULT_LIST_LIMIT}
  `;
});

/** Look one up by id, archived or not. */
export const getArtifact = Effect.fn("memory.getArtifact")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ArtifactRecord>`
    SELECT id, relative_path, project_segment, kind, byte_size, content_sha256,
           thread_id, turn_id, checkpoint_ref, created_at, archived_at
    FROM drive_artifacts WHERE id = ${id}
  `;
  return rows[0] ?? null;
});

/**
 * Mark an artifact archived, which also releases its path for reuse -- the
 * live-path index is partial on `archived_at IS NULL`. The file is left on
 * disk; this is a bookkeeping change, not a delete.
 */
export const archiveArtifact = Effect.fn("memory.archiveArtifact")(function* (input: {
  readonly id: string;
  readonly archivedAt: string;
  /**
   * Supply this to keep the sidecar in step with the row.
   *
   * Optional only so a caller with no drive root on hand is not blocked, but
   * omitting it means the next reindex resurrects the artifact as live -- the
   * sidecar is the authority, so archiving that skips it is not durable.
   */
  readonly driveRoot?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;

  const existing = yield* sql<{ readonly relative_path: string }>`
    SELECT relative_path FROM drive_artifacts
    WHERE id = ${input.id} AND archived_at IS NULL
  `;

  yield* sql`
    UPDATE drive_artifacts SET archived_at = ${input.archivedAt}
    WHERE id = ${input.id} AND archived_at IS NULL
  `;

  const relativePath = existing[0]?.relative_path;
  if (input.driveRoot === undefined || relativePath === undefined) {
    return;
  }

  const absolutePath = resolveWithinRoot({ root: input.driveRoot, relativePath });
  if (!absolutePath) {
    return;
  }

  const sidecarPath = artifactSidecarPath(absolutePath);
  if (!(yield* fs.exists(sidecarPath))) {
    return;
  }

  const sidecar = parseArtifactSidecar(yield* fs.readFileString(sidecarPath));
  if (sidecar === null) {
    return;
  }

  yield* writeFileStringAtomically({
    filePath: sidecarPath,
    contents: serializeArtifactSidecar({ ...sidecar, archived_at: input.archivedAt }),
  });
});

export interface CitingNoteRow {
  readonly note_id: string;
  readonly title: string | null;
  readonly relation: string;
  readonly context: string | null;
}

/**
 * Which notes cite this artifact.
 *
 * The reverse of a note's `sources`. Provenance has to run both ways or
 * "why does the agent believe this?" has no clickable answer.
 */
export const notesCiting = Effect.fn("memory.notesCiting")(function* (artifactId: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<CitingNoteRow>`
    SELECT sources.note_id, notes.title, sources.relation, sources.context
    FROM memory_note_sources AS sources
    LEFT JOIN memory_notes AS notes ON notes.id = sources.note_id
    WHERE sources.artifact_id = ${artifactId}
    ORDER BY sources.note_id
  `;
});

/** Artifacts created since a timestamp -- the input set for a consolidation run. */
export const artifactsCreatedSince = Effect.fn("memory.artifactsCreatedSince")(function* (input: {
  readonly since: string | null;
  readonly limit?: number | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<ArtifactRecord>`
    SELECT id, relative_path, project_segment, kind, byte_size, content_sha256,
           thread_id, turn_id, checkpoint_ref, created_at, archived_at
    FROM drive_artifacts
    WHERE (${input.since} IS NULL OR created_at > ${input.since})
    ORDER BY created_at ASC
    LIMIT ${input.limit ?? DEFAULT_LIST_LIMIT}
  `;
});
