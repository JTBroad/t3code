/**
 * ProjectResolution - Thread to project-segment lookup, via the host.
 *
 * The MCP invocation scope carries a `threadId`, not a repository path, so
 * capture has to resolve one from the other before it can attribute an
 * observation.
 *
 * This used to join `projection_threads` and `projection_projects` directly. It
 * was the only query in the memory app reading a core table, and it is now the
 * one thing memory asks {@link AppHost} for. Keeping the wrapper rather than
 * calling the host at each use site is deliberate: it is the seam that lets the
 * app's own store move out from under core (the projection tables and memory's
 * index no longer have to live in the same database), and it keeps memory's
 * failure vocabulary its own.
 *
 * @module ProjectResolution
 */
import * as Effect from "effect/Effect";

import { AppHost } from "../apps/AppHost.ts";

export interface ResolvedProject {
  readonly repositoryPath: string;
  readonly projectSegment: string;
}

/**
 * Resolve a thread to its project's workspace root and segment.
 *
 * Returns null when the thread, its project, or a usable segment is missing --
 * capture records "unattributed" rather than failing. The host reports the same
 * three cases the same way, so this stays a pass-through.
 */
export const resolveProjectForThread = Effect.fn("memory.resolveProjectForThread")(function* (
  threadId: string,
) {
  const host = yield* AppHost;
  const project = yield* host.resolveProjectForThread(threadId);
  return project === null
    ? null
    : ({
        repositoryPath: project.repositoryPath,
        projectSegment: project.projectSegment,
      } satisfies ResolvedProject);
});
