import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { artifactSidecarPath, parseArtifactSidecar } from "./ArtifactStore.ts";
import { importLegacyArtifactSidecars, LEGACY_IMPORT_MARKER } from "./MemoryLegacyImport.ts";

const layer = it.layer(Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layerMemory()));

/** The shape of the old core table this import reads. */
const seedLegacyTable = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS drive_artifacts (
      id TEXT PRIMARY KEY, relative_path TEXT NOT NULL, project_segment TEXT,
      repository_path TEXT, thread_id TEXT, turn_id TEXT, checkpoint_ref TEXT,
      kind TEXT NOT NULL, byte_size INTEGER NOT NULL, content_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, archived_at TEXT
    )
  `;
  yield* sql`DELETE FROM drive_artifacts`;
});

const setup = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* seedLegacyTable();
  return {
    driveRoot: yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-drive-" }),
    appDataDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-app-" }),
  };
});

layer("legacy drive provenance", (it) => {
  // The one thing the move to a per-app store cannot derive from disk. Without
  // this the files survive but nothing says where they came from.
  it.effect("writes sidecars for artifacts that predate them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const coreSql = yield* SqlClient.SqlClient;
      const { driveRoot, appDataDirectory } = yield* setup();

      yield* fs.writeFileString(path.join(driveRoot, "report.md"), "# Report\n");
      yield* coreSql`
        INSERT INTO drive_artifacts
          (id, relative_path, project_segment, repository_path, thread_id, turn_id,
           checkpoint_ref, kind, byte_size, content_sha256, created_at, archived_at)
        VALUES ('drv_old', 'report.md', 'proj-1', '/code/proj', 'th_9', 'turn_2',
                'abc1234', 'report', 9, 'sha-old', '2026-07-01T00:00:00Z', NULL)
      `;

      const result = yield* importLegacyArtifactSidecars({
        coreSql,
        driveRoot,
        appDataDirectory,
      });
      expect(result.sidecarsWritten).toBe(1);

      const sidecar = parseArtifactSidecar(
        yield* fs.readFileString(artifactSidecarPath(path.join(driveRoot, "report.md"))),
      );
      expect(sidecar?.id).toBe("drv_old");
      expect(sidecar?.thread_id).toBe("th_9");
      expect(sidecar?.turn_id).toBe("turn_2");
      expect(sidecar?.checkpoint_ref).toBe("abc1234");
      expect(sidecar?.created_at).toBe("2026-07-01T00:00:00Z");
    }),
  );

  it.effect("runs once, guarded by a marker file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const coreSql = yield* SqlClient.SqlClient;
      const { driveRoot, appDataDirectory } = yield* setup();

      yield* fs.writeFileString(path.join(driveRoot, "a.md"), "a");
      yield* coreSql`
        INSERT INTO drive_artifacts
          (id, relative_path, kind, byte_size, content_sha256, created_at)
        VALUES ('drv_a', 'a.md', 'scratch', 1, 'sha', '2026-07-01T00:00:00Z')
      `;

      expect(
        (yield* importLegacyArtifactSidecars({ coreSql, driveRoot, appDataDirectory }))
          .sidecarsWritten,
      ).toBe(1);
      expect(yield* fs.exists(path.join(appDataDirectory, LEGACY_IMPORT_MARKER))).toBe(true);

      // Second call is a no-op even though the rows are still there.
      expect(
        (yield* importLegacyArtifactSidecars({ coreSql, driveRoot, appDataDirectory }))
          .sidecarsWritten,
      ).toBe(0);
    }),
  );

  it.effect("skips a row whose file is gone", () =>
    Effect.gen(function* () {
      const coreSql = yield* SqlClient.SqlClient;
      const { driveRoot, appDataDirectory } = yield* setup();

      yield* coreSql`
        INSERT INTO drive_artifacts
          (id, relative_path, kind, byte_size, content_sha256, created_at)
        VALUES ('drv_missing', 'not-on-disk.md', 'scratch', 1, 'sha', '2026-07-01T00:00:00Z')
      `;

      const result = yield* importLegacyArtifactSidecars({
        coreSql,
        driveRoot,
        appDataDirectory,
      });
      expect(result.sidecarsWritten).toBe(0);
      expect(result.skipped).toBe(1);
    }),
  );

  // A fresh install has no such table at all, and must still start.
  it.effect("is a no-op when the old table does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const coreSql = yield* SqlClient.SqlClient;
      yield* coreSql`DROP TABLE IF EXISTS drive_artifacts`;

      const result = yield* importLegacyArtifactSidecars({
        coreSql,
        driveRoot: yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-empty-" }),
        appDataDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-empty-app-" }),
      });
      expect(result).toEqual({ sidecarsWritten: 0, skipped: 0 });
    }),
  );
});
