/**
 * MemoryLegacyImport - Rescue provenance that predates the sidecars.
 *
 * The store moved to its own database and is repopulated by reindexing files on
 * disk rather than by copying rows. That works because everything the index holds
 * is derivable -- with one exception, and it is a real one.
 *
 * Artifacts written before drive sidecars existed have their provenance (thread,
 * turn, checkpoint, kind, created-at) only in the old `drive_artifacts` table in
 * the core database. Reindexing the drive folder would skip them for having no
 * sidecar, and the information would be gone: the files would survive, but
 * nothing would ever say where they came from.
 *
 * So before the first reindex, this walks the old table and writes the sidecars
 * those artifacts should have had. After that the normal derivable path takes
 * over and this never runs again.
 *
 * Deliberately one-way and additive: it writes sidecars that are missing and
 * touches nothing else. It never deletes the old tables -- if this import is
 * wrong in some way we have not thought of, the original rows are still there to
 * look at.
 *
 * @module MemoryLegacyImport
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  artifactSidecarPath,
  serializeArtifactSidecar,
  type ArtifactSidecar,
} from "./ArtifactStore.ts";
import { resolveWithinRoot } from "./MemoryPaths.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

/**
 * Marker file recording that the import ran.
 *
 * A file rather than a row: it has to survive the app database being deleted,
 * because "delete the index and reindex" is a supported repair and it must not
 * re-run a migration from a table that may no longer exist.
 */
export const LEGACY_IMPORT_MARKER = "legacy-import-complete";

interface LegacyArtifactRow {
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

export interface LegacyImportResult {
  readonly sidecarsWritten: number;
  readonly skipped: number;
}

/**
 * Write missing sidecars for artifacts recorded in the core database.
 *
 * Takes the core `SqlClient` explicitly rather than through context: this is the
 * one place in the memory app that reads core state directly, and passing it in
 * keeps that visible at the call site instead of hiding it in a service lookup.
 *
 * Never fails. A missing table is the normal case on a fresh install, and an
 * install that cannot import legacy provenance should still start.
 */
const importLegacyArtifactSidecarsUnsafe = Effect.fn("memory.importLegacySidecars")(
  function* (input: {
    readonly coreSql: SqlClient.SqlClient;
    readonly driveRoot: string;
    readonly appDataDirectory: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(input.appDataDirectory, LEGACY_IMPORT_MARKER);

    if (yield* fs.exists(markerPath)) {
      return { sidecarsWritten: 0, skipped: 0 } satisfies LegacyImportResult;
    }

    const rows = yield* input.coreSql<LegacyArtifactRow>`
    SELECT id, relative_path, project_segment, repository_path, thread_id, turn_id,
           checkpoint_ref, kind, byte_size, content_sha256, created_at, archived_at
    FROM drive_artifacts
  `;

    let sidecarsWritten = 0;
    let skipped = 0;

    for (const row of rows) {
      const absolutePath = resolveWithinRoot({
        root: input.driveRoot,
        relativePath: row.relative_path,
      });
      // A row whose file is gone, or whose path no longer resolves inside the
      // configured root, has nothing to attach provenance to.
      if (!absolutePath || !(yield* fs.exists(absolutePath))) {
        skipped += 1;
        continue;
      }

      const sidecarPath = artifactSidecarPath(absolutePath);
      if (yield* fs.exists(sidecarPath)) {
        continue;
      }

      const sidecar: ArtifactSidecar = {
        id: row.id,
        relative_path: row.relative_path,
        project_segment: row.project_segment,
        repository_path: row.repository_path,
        thread_id: row.thread_id,
        turn_id: row.turn_id,
        checkpoint_ref: row.checkpoint_ref,
        kind: row.kind,
        byte_size: row.byte_size,
        content_sha256: row.content_sha256,
        created_at: row.created_at,
        archived_at: row.archived_at,
      };

      yield* writeFileStringAtomically({
        filePath: sidecarPath,
        contents: serializeArtifactSidecar(sidecar),
      });
      sidecarsWritten += 1;
    }

    yield* fs.makeDirectory(input.appDataDirectory, { recursive: true });
    yield* writeFileStringAtomically({
      filePath: markerPath,
      contents: `${DateTime.formatIso(yield* DateTime.now)}\n`,
    });

    return { sidecarsWritten, skipped } satisfies LegacyImportResult;
  },
);

export const importLegacyArtifactSidecars = (input: {
  readonly coreSql: SqlClient.SqlClient;
  readonly driveRoot: string;
  readonly appDataDirectory: string;
}): Effect.Effect<LegacyImportResult, never, FileSystem.FileSystem | Path.Path> =>
  importLegacyArtifactSidecarsUnsafe(input).pipe(
    Effect.catchCause((cause) =>
      // A fresh install has no `drive_artifacts` table at all, which surfaces as
      // a SQL error. Debug rather than warning: the common case is not a problem,
      // and the uncommon one leaves the files themselves untouched.
      Effect.logDebug("legacy drive provenance not imported", { cause }).pipe(
        Effect.as({ sidecarsWritten: 0, skipped: 0 } satisfies LegacyImportResult),
      ),
    ),
  );
