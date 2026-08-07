import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { toProjectSegment } from "./MemoryPaths.ts";
import { resolveProjectForThread } from "./ProjectResolution.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const seed = Effect.fn(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly worktreePath?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 39 });
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${input.projectId}, 'Project', ${input.workspaceRoot}, '[]',
            '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
  `;
  yield* sql`
    INSERT INTO projection_threads
      (thread_id, project_id, title, worktree_path, created_at, updated_at)
    VALUES (${input.threadId}, ${input.projectId}, 'Thread',
            ${input.worktreePath ?? null}, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
  `;
});

layer("resolveProjectForThread", (it) => {
  it.effect("resolves a thread to its project's workspace root", () =>
    Effect.gen(function* () {
      yield* seed({ threadId: "th_1", projectId: "p_1", workspaceRoot: "/code/t3code" });

      const resolved = yield* resolveProjectForThread("th_1");
      expect(resolved?.repositoryPath).toBe("/code/t3code");
      expect(resolved?.projectSegment).toBe(toProjectSegment("/code/t3code"));
    }),
  );

  // A worktree is per-thread and per-branch. Keying memory on it would split
  // one repository's notes across every branch ever worked on.
  it.effect("keys on the workspace root, not the thread's worktree path", () =>
    Effect.gen(function* () {
      yield* seed({
        threadId: "th_1",
        projectId: "p_1",
        workspaceRoot: "/code/t3code",
        worktreePath: "/code/worktrees/feature-branch",
      });

      const resolved = yield* resolveProjectForThread("th_1");
      expect(resolved?.repositoryPath).toBe("/code/t3code");
      expect(resolved?.projectSegment).not.toContain("feature");
    }),
  );

  it.effect("returns null for an unknown thread", () =>
    Effect.gen(function* () {
      yield* seed({ threadId: "th_1", projectId: "p_1", workspaceRoot: "/code/t3code" });
      expect(yield* resolveProjectForThread("th_missing")).toBeNull();
    }),
  );

  // Two checkouts with the same basename must land in different buckets.
  it.effect("distinguishes same-named repositories under different parents", () =>
    Effect.gen(function* () {
      yield* seed({ threadId: "th_a", projectId: "p_a", workspaceRoot: "/one/api" });
      const first = yield* resolveProjectForThread("th_a");

      yield* seed({ threadId: "th_b", projectId: "p_b", workspaceRoot: "/two/api" });
      const second = yield* resolveProjectForThread("th_b");

      expect(first?.projectSegment).not.toBe(second?.projectSegment);
    }),
  );
});
