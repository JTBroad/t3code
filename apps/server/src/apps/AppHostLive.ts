/**
 * AppHostLive - The core-side implementation of {@link AppHost}.
 *
 * This module is allowed to know about core internals -- that is the trade the
 * host seam exists to make. Everything an app is entitled to is reached from
 * here, so the list of core dependencies an app can transitively touch is the
 * import list of this one file.
 *
 * @module AppHostLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AppHost, AppHostError, APP_HOST_API_VERSION } from "./AppHost.ts";
import { resolveAppPaths } from "./AppPaths.ts";
import { ServerConfig } from "../config.ts";
import { toProjectSegment } from "../memory/MemoryPaths.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;

  return {
    apiVersion: APP_HOST_API_VERSION,

    /**
     * Uses `projection_projects.workspace_root`, deliberately not
     * `projection_threads.worktree_path`: a worktree is per-thread and
     * per-branch, so keying app data on it would split one repository's data
     * across every branch ever worked on.
     */
    resolveProjectForThread: (threadId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly workspace_root: string | null }>`
          SELECT projects.workspace_root
          FROM projection_threads AS threads
          JOIN projection_projects AS projects ON projects.project_id = threads.project_id
          WHERE threads.thread_id = ${threadId}
          LIMIT 1
        `;

        const repositoryPath = rows[0]?.workspace_root ?? null;
        if (!repositoryPath) {
          return null;
        }

        const projectSegment = toProjectSegment(repositoryPath);
        if (!projectSegment) {
          return null;
        }

        return { repositoryPath, projectSegment };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AppHostError({
              operation: "resolveProjectForThread",
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
      ),

    paths: (appId: string) =>
      Effect.gen(function* () {
        const resolved = resolveAppPaths({ stateDir: config.stateDir, appId });
        if (resolved === null) {
          return yield* new AppHostError({
            operation: "paths",
            reason: `not a valid app id: ${appId}`,
          });
        }
        return {
          dataDirectory: resolved.dataDirectory,
          databasePath: resolved.databasePath,
        };
      }),
  } satisfies AppHost["Service"];
});

export const layer = Layer.effect(AppHost, make);
