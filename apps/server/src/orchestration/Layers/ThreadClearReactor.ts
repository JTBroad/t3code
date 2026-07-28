import type { CheckpointRef, OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import {
  ThreadClearReactor,
  type ThreadClearReactorShape,
} from "../Services/ThreadClearReactor.ts";
import { logCleanupCauseUnlessInterrupted } from "./ThreadDeletionReactor.ts";

type ThreadClearedEvent = Extract<OrchestrationEvent, { type: "thread.cleared" }>;

/**
 * Upper bound on the turn-0..N checkpoint ref scan. Checkpoint turn counts are
 * assigned contiguously from 0 by `CheckpointReactor`, so the scan stops at the
 * first missing ref; the cap is only a guard against a pathological thread.
 */
const MAX_CHECKPOINT_TURN_SCAN = 1024;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const receiptBus = yield* RuntimeReceiptBus;

  // 1. Tear down the live provider session. The in-memory adapter context holds
  //    turns, pendingApprovals, pendingUserInputs and resumeSessionId; all of it
  //    must go for the agent to genuinely forget the conversation.
  const stopProviderSession = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread clear cleanup skipped provider session stop",
      threadId,
    });

  // 2. Drop the persisted resume cursor. This is the line that makes a clear a
  //    clear: `ClaudeAdapter.startSession` only mints a fresh session id when
  //    `resumeState.resume` is absent, so a surviving cursor would resume the
  //    provider's own server-side history into a visually empty thread.
  //
  //    `ProviderSessionDirectoryShape` has no delete, so nulling is the only
  //    route. The persistence layer writes `resumeCursor` whenever it is not
  //    `undefined`, and the SQL upsert overwrites `resume_cursor_json` from the
  //    excluded row, so an explicit `null` is stored rather than ignored.
  //
  //    Note: `adapter.rollbackThread` is NOT a substitute. It splices
  //    `context.turns` and rewrites the cursor, but preserves
  //    `context.resumeSessionId`, so `resume` survives the rewrite.
  const clearResumeCursor = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: directory.getBinding(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) => directory.upsert({ ...binding, resumeCursor: null }),
          }),
        ),
      ),
      message: "thread clear cleanup skipped provider resume cursor reset",
      threadId,
    });

  // Resolve the checkpoint workspace from the thread/project config. The
  // provider session has already been stopped by this point, so the session
  // runtime cwd is not a reliable source here.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (threadId: ThreadId) {
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return undefined;
    }

    const project = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));

    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    if (!cwd) {
      return undefined;
    }
    if (!isGitRepository(cwd)) {
      return undefined;
    }
    return cwd;
  });

  // 3./4. Delete the thread's checkpoint refs (the projection just dropped
  //       them, so leaving them on disk orphans them) and capture a fresh
  //       turn-0 baseline so a later revert has a target.
  //
  //       Deliberately no `restoreCheckpoint` call: a clear must leave the
  //       user's working tree exactly as it is. That also means the new turn-0
  //       baseline is the *current* tree, not the tree at thread creation.
  const resetCheckpoints = Effect.fn("resetCheckpoints")(function* (event: ThreadClearedEvent) {
    const threadId = event.payload.threadId;
    const cwd = yield* resolveCheckpointCwd(threadId);
    if (!cwd) {
      return;
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (let turnCount = 0; turnCount < MAX_CHECKPOINT_TURN_SCAN; turnCount += 1) {
      const checkpointRef = checkpointRefForThreadTurn(threadId, turnCount);
      const exists = yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef });
      if (!exists) {
        break;
      }
      staleCheckpointRefs.push(checkpointRef);
    }

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs: staleCheckpointRefs });
    }

    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
    yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: baselineCheckpointRef });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: 0,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.payload.clearedAt,
    });
  });

  const resetCheckpointsSafely = (event: ThreadClearedEvent) =>
    logCleanupCauseUnlessInterrupted({
      effect: resetCheckpoints(event),
      message: "thread clear cleanup skipped checkpoint reset",
      threadId: event.payload.threadId,
    });

  const processThreadCleared = Effect.fn("processThreadCleared")(function* (
    event: ThreadClearedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* clearResumeCursor(threadId);
    yield* resetCheckpointsSafely(event);
  });

  const processThreadClearedSafely = (event: ThreadClearedEvent) =>
    processThreadCleared(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread clear reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadClearedSafely);

  const start: ThreadClearReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.cleared") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadClearReactorShape;
});

export const ThreadClearReactorLive = Layer.effect(ThreadClearReactor, make);
