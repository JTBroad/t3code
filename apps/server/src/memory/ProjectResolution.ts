/**
 * ProjectResolution - Thread to project-segment lookup.
 *
 * The MCP invocation scope carries a `threadId`, not a repository path, so
 * capture has to resolve one from the other before it can attribute an
 * observation. Lives here rather than in MemoryPaths because it needs the SQL
 * client, and a path module should not own a query.
 *
 * @module ProjectResolution
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toProjectSegment } from "./MemoryPaths.ts";

export interface ResolvedProject {
  readonly repositoryPath: string;
  readonly projectSegment: string;
}

/**
 * Resolve a thread to its project's workspace root and segment.
 *
 * Uses `projection_projects.workspace_root`, deliberately not
 * `projection_threads.worktree_path`: a worktree is per-thread and per-branch,
 * so keying memory on it would split one repository's notes across every
 * branch ever worked on. The workspace root is the stable identity.
 *
 * Returns null when the thread, its project, or a usable segment is missing --
 * capture records "unattributed" rather than failing.
 */
export const resolveProjectForThread = Effect.fn("memory.resolveProjectForThread")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;

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

  return { repositoryPath, projectSegment } satisfies ResolvedProject;
});
