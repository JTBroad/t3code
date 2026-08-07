import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LINKED_AT = "1969-12-30T00:00:00.000Z";
const THREAD_UPDATED_AT = "2025-12-01T00:00:00.000Z";

function link(overrides: Partial<ThreadLinkedPullRequest> = {}): ThreadLinkedPullRequest {
  return {
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
    title: "Add the thing",
    headBranch: "feature/thing",
    baseBranch: "main",
    state: "open",
    cwd: "/repo",
    linkedAt: LINKED_AT,
    linkedBy: "user",
    refreshedAt: LINKED_AT,
    ...overrides,
  };
}

function makeReadModel(input: {
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: THREAD_UPDATED_AT,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: input.linkedPullRequest ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("thread pull request link decider", (it) => {
  it.effect("links a pull request and stamps the thread", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-link"),
          threadId: ThreadId.make("thread-1"),
          pullRequest: link({ linkedAt: NOW, refreshedAt: NOW }),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.pull-request-linked");
      if (events[0]?.type === "thread.pull-request-linked") {
        expect(events[0].payload.pullRequest.number).toBe(42);
        // A fresh link stamps the command time, not the thread's old updatedAt.
        expect(events[0].payload.updatedAt).toBe(events[0].occurredAt);
      }
    }),
  );

  it.effect("re-linking the identical PR is a projected no-op", () =>
    Effect.gen(function* () {
      // The refresher re-links on every sweep; an unchanged PR must not churn
      // updatedAt and reorder the sidebar.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-relink-same"),
          threadId: ThreadId.make("thread-1"),
          pullRequest: link({ linkedAt: NOW, refreshedAt: NOW }),
        },
        readModel: makeReadModel({ linkedPullRequest: link() }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.pull-request-linked") {
        expect(events[0].payload.updatedAt).toBe(THREAD_UPDATED_AT);
      }
    }),
  );

  it.effect("a state change on the same PR stamps a fresh updatedAt", () =>
    Effect.gen(function* () {
      // This is the merge that should settle the thread — it has to look like
      // new information, not a duplicate.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-relink-merged"),
          threadId: ThreadId.make("thread-1"),
          pullRequest: link({ state: "merged", refreshedAt: NOW }),
        },
        readModel: makeReadModel({ linkedPullRequest: link() }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.pull-request-linked") {
        expect(events[0].payload.pullRequest.state).toBe("merged");
        expect(events[0].payload.updatedAt).toBe(events[0].occurredAt);
        expect(events[0].payload.updatedAt).not.toBe(THREAD_UPDATED_AT);
      }
    }),
  );

  it.effect("a refresh keeps the original linkedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-refresh"),
          threadId: ThreadId.make("thread-1"),
          pullRequest: link({ state: "merged", linkedAt: NOW }),
        },
        readModel: makeReadModel({ linkedPullRequest: link() }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.pull-request-linked") {
        expect(events[0].payload.pullRequest.linkedAt).toBe(LINKED_AT);
      }
    }),
  );

  it.effect("linking a different PR replaces the link and re-stamps linkedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-replace"),
          threadId: ThreadId.make("thread-1"),
          pullRequest: link({ number: 99, linkedAt: NOW }),
        },
        readModel: makeReadModel({ linkedPullRequest: link() }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.pull-request-linked") {
        expect(events[0].payload.pullRequest.number).toBe(99);
        expect(events[0].payload.pullRequest.linkedAt).toBe(NOW);
      }
    }),
  );

  it.effect("unlinks a linked pull request", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ linkedPullRequest: link() }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.pull-request-unlinked");
      if (events[0]?.type === "thread.pull-request-unlinked") {
        expect(events[0].payload.updatedAt).toBe(events[0].occurredAt);
      }
    }),
  );

  it.effect("unlinking an unlinked thread is a projected no-op", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.unlink",
          commandId: CommandId.make("cmd-unlink-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.pull-request-unlinked") {
        expect(events[0].payload.updatedAt).toBe(THREAD_UPDATED_AT);
      }
    }),
  );

  it.effect("refuses to link on an archived thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.pull-request.link",
          commandId: CommandId.make("cmd-link-archived"),
          threadId: ThreadId.make("thread-1"),
          pullRequest: link(),
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
