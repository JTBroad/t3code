/**
 * Thread toolkit handlers.
 *
 * Lets the agent working in a thread attach the pull request that thread is
 * about, so the user does not have to go to the menu and do it by hand. The
 * thread comes from the invocation scope, never from arguments -- see
 * `tools.ts` for why.
 *
 * @module thread/handlers
 */
import { CommandId, ThreadLinkedPullRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadToolkit } from "./tools.ts";

const decodeLinkedPullRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadLinkedPullRequest),
);

/**
 * The repo a reference resolves against: the thread's own worktree when it has
 * one, else the project's workspace root. Same precedence the UI uses, so a
 * link made by the agent and one made from the menu resolve identically.
 */
const threadRepositoryPath = Effect.fn("thread.repositoryPath")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly worktree_path: string | null;
    readonly workspace_root: string | null;
  }>`
    SELECT threads.worktree_path, projects.workspace_root
    FROM projection_threads AS threads
    JOIN projection_projects AS projects ON projects.project_id = threads.project_id
    WHERE threads.thread_id = ${threadId}
    LIMIT 1
  `;
  return rows[0]?.worktree_path ?? rows[0]?.workspace_root ?? null;
});

const threadLinkedPullRequest = Effect.fn("thread.linkedPullRequest")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly linked_pull_request: string | null }>`
    SELECT linked_pull_request
    FROM projection_threads
    WHERE thread_id = ${threadId}
    LIMIT 1
  `;
  const raw = rows[0]?.linked_pull_request ?? null;
  return raw === null ? null : decodeLinkedPullRequest(raw);
});

/**
 * A SQL fault or a git failure is not something the model can act on, and the
 * tool contract should stay "linked" or "capability denied". Dying still
 * surfaces the fault in logs and to the MCP caller. Mirrors the memory
 * toolkit's stance.
 */
const dieOnInfrastructureFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.orDie(effect);

/** Effect-injected randomness, so tests can pin command ids. */
const commandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);

const handlers = {
  thread_link_pull_request: Effect.fn("thread_link_pull_request")(function* (input: {
    readonly reference: string;
  }) {
    const scope = yield* McpInvocationContext.requireMcpCapability("thread");
    const cwd = yield* dieOnInfrastructureFailure(threadRepositoryPath(scope.threadId));
    if (cwd === null) {
      return yield* Effect.die(
        new Error(`Thread ${scope.threadId} has no repository to resolve a pull request against.`),
      );
    }

    // Resolution goes through the same provider path the UI uses, so an
    // agent cannot record a PR the host does not actually have.
    const gitWorkflow = yield* GitWorkflowService;
    const { pullRequest } = yield* dieOnInfrastructureFailure(
      gitWorkflow.resolvePullRequest({ cwd, reference: input.reference }),
    );

    const now = DateTime.formatIso(yield* DateTime.now);
    const engine = yield* OrchestrationEngineService;
    yield* dieOnInfrastructureFailure(
      engine.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(yield* commandUuid),
        threadId: scope.threadId,
        pullRequest: {
          number: pullRequest.number,
          url: pullRequest.url,
          title: pullRequest.title,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          cwd,
          linkedAt: now,
          linkedBy: "agent",
          refreshedAt: now,
        },
      }),
    );

    return {
      linked: true,
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      state: pullRequest.state,
    };
  }),

  thread_unlink_pull_request: Effect.fn("thread_unlink_pull_request")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("thread");
    const engine = yield* OrchestrationEngineService;
    yield* dieOnInfrastructureFailure(
      engine.dispatch({
        type: "thread.pull-request.unlink",
        commandId: CommandId.make(yield* commandUuid),
        threadId: scope.threadId,
      }),
    );
    return { unlinked: true };
  }),

  thread_get_pull_request: Effect.fn("thread_get_pull_request")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("thread");
    const link = yield* dieOnInfrastructureFailure(threadLinkedPullRequest(scope.threadId));
    if (link === null) {
      return { linked: false, number: null, url: null, title: null, state: null };
    }
    return {
      linked: true,
      number: link.number,
      url: link.url,
      title: link.title,
      state: link.state,
    };
  }),
};

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer(handlers);
