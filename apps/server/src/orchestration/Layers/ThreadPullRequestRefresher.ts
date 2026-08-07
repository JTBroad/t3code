/**
 * ThreadPullRequestRefresher - keeps explicitly linked PRs current.
 *
 * A linked PR carries a `state` snapshot, and that snapshot is what auto-settle
 * reads in manual link mode. Nothing else refreshes it: the branch-derived
 * status poll only looks at whatever branch a client happens to be subscribed
 * to, and a linked PR is deliberately independent of the checkout. Without this
 * loop a thread linked to a PR would never notice the PR merging, which is
 * exactly the moment the thread should settle.
 *
 * Re-linking is the update mechanism — the decider treats an identical snapshot
 * as a no-op re-emission, so a poll that finds nothing changed costs one event
 * and no projection churn.
 *
 * @module ThreadPullRequestRefresher
 */
import { CommandId, ThreadId, ThreadLinkedPullRequest } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";

/**
 * Slower than the branch status poll on purpose. A merge is not urgent to
 * notice — the thread settles a few minutes later instead of instantly — and
 * every tick costs one provider API call per linked thread, which is the kind
 * of thing that trips rate limits on a machine with many threads open.
 */
const REFRESH_INTERVAL = Duration.minutes(5);

const decodeLinkedPullRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ThreadLinkedPullRequest),
);

interface LinkedRow {
  readonly thread_id: string;
  readonly linked_pull_request: string;
}

const refreshOnce = Effect.fn("threadPullRequestRefresher.tick")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Archived and deleted threads are skipped: the decider rejects commands on
  // archived threads anyway, and nothing renders their badge.
  const rows = yield* sql<LinkedRow>`
    SELECT thread_id, linked_pull_request
    FROM projection_threads
    WHERE linked_pull_request IS NOT NULL
      AND archived_at IS NULL
      AND deleted_at IS NULL
  `;
  if (rows.length === 0) {
    return;
  }

  const gitWorkflow = yield* GitWorkflowService;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  for (const row of rows) {
    // One thread's bad data or unreachable host must not stop the rest of the
    // sweep, so every step below is contained per row.
    yield* Effect.gen(function* () {
      const link = decodeLinkedPullRequest(row.linked_pull_request);
      const { pullRequest } = yield* gitWorkflow.resolvePullRequest({
        cwd: link.cwd,
        reference: String(link.number),
      });

      // Nothing worth an event: skip before dispatching so a quiet sweep is
      // genuinely free rather than "free after the decider notices".
      if (pullRequest.state === link.state && pullRequest.title === link.title) {
        return;
      }

      const now = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.pull-request.link",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        threadId: ThreadId.make(row.thread_id),
        pullRequest: {
          ...link,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          refreshedAt: now,
        },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("Linked pull request refresh failed; keeping the last known state.").pipe(
          Effect.annotateLogs({
            operation: "threadPullRequestRefresher",
            threadId: row.thread_id,
            cause,
          }),
        ),
      ),
    );
  }
});

const make = Effect.gen(function* () {
  yield* forkParked(
    refreshOnce().pipe(
      // A failure here is already logged per row; a surviving one must not kill
      // the loop for the rest of the process's life.
      Effect.ignore,
      Effect.repeat(Schedule.spaced(REFRESH_INTERVAL)),
    ),
  );
});

export const ThreadPullRequestRefresherLive = Layer.effectDiscard(make);
