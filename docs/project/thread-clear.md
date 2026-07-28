# Spec: Clear a thread in place

Status: proposal

## Goal

Empty a thread's conversation — messages, turns, activity, and the context the
agent harness resumes from — while keeping the thread itself alive: same id,
title, model selection, runtime mode, interaction mode, branch, worktree, and
sidebar position. The user's working tree is **not** touched.

Effectively: "start over with this agent, keep the desk it's sitting at."

## Does anything like this exist today?

No. The thread command set in `packages/contracts/src/orchestration.ts` is
`create`, `delete`, `archive`/`unarchive`, `settle`/`unsettle`,
`snooze`/`unsnooze`, `meta.update`, `runtime-mode.set`, `interaction-mode.set`,
`turn.start`, `turn.interrupt`, `approval.respond`, `user-input.respond`,
`checkpoint.revert`, and `session.stop`. Nothing empties a thread in place.

Two near-misses, and why neither is the feature:

- **`thread.checkpoint.revert` at `turnCount: 0`** does empty the conversation,
  but `CheckpointReactor.handleRevertRequested` also calls
  `checkpointStore.restoreCheckpoint(...)` — it rolls the **filesystem** back to
  the turn-0 snapshot. That's disqualifying: we want the code changes kept.
- **`thread.session.stop`** tears down the provider session but leaves both the
  transcript and the persisted resume cursor intact, so the next turn resumes
  right where it left off. It's a disconnect, not a clear.

## The two layers

This is the part that makes the feature non-trivial. Clearing the UI is easy;
clearing what the agent sees is the real work, and they're stored separately.

### Layer 1 — the orchestration projection (what the UI shows)

`apps/server/src/orchestration/projector.ts` folds events into an
`OrchestrationThread` holding `messages`, `activities`, `proposedPlans`,
`checkpoints`, `latestTurn`, and `session`.

Good news: the `thread.reverted` case (projector.ts ~line 670) is almost exactly
the projection we need — it truncates `checkpoints`, `messages`, `proposedPlans`,
`activities`, and recomputes `latestTurn`. A `thread.cleared` case is a strictly
simpler sibling: set all five to empty/null, leave every meta field alone.

### Layer 2 — the provider resume cursor (what the agent sees)

This is the one that will bite whoever implements it.

`ProviderSessionDirectory` persists a `ProviderRuntimeBinding` per thread
carrying an opaque `resumeCursor`. For Claude that cursor is
`{ threadId, resume: <sessionId>, resumeSessionAt: <lastAssistantUuid>, turnCount }`
(`ClaudeAdapter.updateResumeCursor`, ~line 1447).

In `ClaudeAdapter.startSession` (~line 3169):

```ts
const existingResumeSessionId = resumeState?.resume;
const newSessionId = existingResumeSessionId === undefined ? yield * randomUUIDv4 : undefined;
```

So the adapter starts a **fresh** session only when `resume` is absent. If the
cursor still carries a session id, the next turn resumes the provider's own
server-side history and the user sees a "cleared" thread that still remembers
everything. **Clearing the projection without clearing the cursor is the bug this
spec exists to prevent.**

Note also that `adapter.rollbackThread(threadId, N)` is **not** sufficient on its
own. It splices `context.turns` and calls `updateResumeCursor`, but that rewrite
preserves `context.resumeSessionId` — so `resume` survives. Rollback trims the
adapter's local view; it does not forget the session.

Complication: `ProviderSessionDirectoryShape` exposes `upsert`, `getProvider`,
`getBinding`, `listThreadIds`, `listBindings` — there is **no delete**. Clearing
the cursor means upserting `resumeCursor: null` and verifying the persistence
layer stores the null rather than treating it as "no change". `ProviderService`
already distinguishes these (`hasResumeCursor = resumeCursor !== null &&
resumeCursor !== undefined`, ~line 369), which is a good sign, but it needs
checking end to end.

## Design

### New command and event

`thread.clear` command → `thread.cleared` event, following the shape of
`ThreadSettleCommand` / `ThreadUnsettleCommand` in `orchestration.ts`:

```ts
const ThreadClearCommand = Schema.Struct({
  type: Schema.Literal("thread.clear"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});
```

Register in `DispatchableClientOrchestrationCommand` and
`ClientOrchestrationCommand`, add `"thread.cleared"` to the event-type union, and
add the payload schema.

### Decider

New `case "thread.clear"` in `decider.ts`. Guards, modeled on the existing cases:

- Thread must exist and not be deleted.
- **Refuse while a turn is in flight.** `thread.turn.start` has precedent
  (`hasOpenBlockingRequest`, `threadHasQueuedTurnStart`). Clearing mid-turn would
  race the adapter writing turn results into a projection that no longer has a
  turn to attach them to. Either refuse, or require an interrupt first — refusing
  is simpler and the UI can gate the affordance on `status !== "running"`.
- Idempotent: clearing an already-empty thread emits the event anyway (same
  re-emission pattern the settle/unsettle cases use).

### Projector

New `case "thread.cleared"`: `messages: []`, `activities: []`,
`proposedPlans: []`, `checkpoints: []`, `latestTurn: null`,
`updatedAt: event.occurredAt`. Everything else on the thread is untouched.

Open question — **`settledOverride` / `settledAt`**: a settled thread that gets
cleared is arguably active again. Recommendation: leave settle state alone and
let the existing activity-based unsettle rules handle it on the next turn.
Clearing is not activity.

### Reactor

New reactor case (or an extension of `CheckpointReactor`, though a separate
`ThreadClearReactor` keeps checkpoint logic uncontaminated), on
`thread.cleared`:

1. Stop the live provider session for the thread if one exists — the in-memory
   adapter context holds `turns`, `pendingApprovals`, `pendingUserInputs`, and
   `resumeSessionId`, and all of it must go. Reuse the `thread.session.stop`
   path rather than reimplementing teardown.
2. `directory.upsert({ ...binding, resumeCursor: null })` so the next
   `startSession` takes the `newSessionId` branch.
3. Delete the thread's checkpoint refs via
   `checkpointStore.deleteCheckpointRefs` — the projection just dropped them, so
   leaving them on disk orphans them. `handleRevertRequested` already does this
   for the stale subset and is the model to copy. **Do not** call
   `restoreCheckpoint`; that's the filesystem revert we're deliberately avoiding.
4. Capture a fresh turn-0 baseline checkpoint, so a later revert has something
   to target. The baseline-capture path already exists in `CheckpointReactor`.

Step 4 is the subtle one: after a clear, the thread's "turn 0" is the _current_
working tree, not the tree as of thread creation. That's the correct semantic
given we're keeping file changes, but it does mean the old baseline is gone and
a user cannot revert past the clear.

### Client

`apps/web` — an `attemptClear` callback mirroring `attemptSettle` /
`attemptSnooze` in `SidebarV2.tsx`: dispatch, handle `_tag === "Failure"` with a
`stackedThreadToast`, and guard double-dispatch with a
`clearingThreadKeysRef` set.

**Entry point: the sidebar row right-click menu.** `handleThreadContextMenu` in
`SidebarV2.tsx` already builds the item array passed to `api.contextMenu.show`
(`Settle`, `Snooze`, `Mark unread`, `Delete`), and the result handler branches on
`clicked.value`. Adding `{ id: "clear", label: "Clear thread" }` plus a matching
branch is the whole surface. Place it above `Delete` and below `Mark unread` —
grouped with the destructive end of the menu but visibly not the same thing.

Chat-view, command-palette, and `/clear`-composer entry points are explicitly out
of scope for this pass. They can layer on top of `attemptClear` later without
touching the server work.

**Confirm dialog.** Required: this is destructive and, unlike snooze, has no
undo — the transcript is gone from the projection and the provider session id is
unrecoverable. A toast-with-Undo is **not** available here.

Follow the delete precedent exactly (`SidebarV2.tsx` ~line 2113):
`api.dialogs.confirm(...)`, bail on `confirmed._tag === "Failure" ||
!confirmed.value`. Copy should make the file-safety promise explicit, because
that's the distinction users need to trust:

> Clear this thread?
> The conversation and the agent's memory of it are removed. Your file changes
> are kept.

Note `confirmThreadDelete` is a client setting that lets users skip the delete
confirm. Recommendation: do **not** wire clear to that flag, and do not add a
sibling setting in this pass — always confirm.

**Multi-select.** `handleMultiSelectContextMenu` builds the `(N)` variants of
each action. Recommendation: **omit clear from the multi-select menu** for now.
"Clear (7)" is a large irreversible action behind one click, and the single-row
path covers the actual use case. Revisit if it's actually wanted.

**Disabled state.** The decider refuses a clear while a turn is in flight, so the
menu item should be gated the same way rather than letting the user fire a
command that will fail — hide or disable when the thread's session status is
`running` or `starting`, matching how `canSnoozeSelection` gates the snooze item.

### Capability gate

Settle and snooze are both gated on
`serverConfigs.get(environmentId)?.environment.capabilities.*`, because an older
server would silently drop the command. Clear needs the same treatment: add a
`threadClear` capability, and hide the affordance when the environment doesn't
advertise it.

## Risks

1. **The resume cursor is the whole feature.** If step 2 of the reactor is
   missed or the persistence layer coerces `null` to "unchanged", the thread
   looks cleared and behaves as if it wasn't. Worth an explicit integration test
   against `ProviderSessionDirectory`.
2. **Per-adapter divergence.** The `resume` semantics above are Claude's. Codex,
   Copilot, Cursor, Grok, and OpenCode each have their own adapter and their own
   cursor shape; `resumeCursor` is typed `unknown`. Nulling the cursor should be
   adapter-agnostic, but each adapter's `startSession` needs checking for a
   "resume if present" branch that could survive a null.
3. **Event log growth.** Clearing drops the projection but the events remain in
   the log. Replay from scratch must fold `thread.cleared` correctly or a
   rebuilt projection will resurrect the transcript. This is why clear has to be
   an event and not a mutation.
4. **In-flight turn.** Covered by the decider guard, but worth a manual test:
   clear while the agent is mid-tool-call and confirm the refusal is clean.
5. **Orphaned checkpoint refs** if step 3 is skipped — disk leak, no user-visible
   symptom until it accumulates.
6. **KNOWN FOLLOW-UP — clear-then-immediate-message race.** The clear reactor
   consumes the event stream on its own worker, independent of the provider
   command path. If the user sends a message immediately after clearing, the new
   session start can read the binding _before_ the reactor nulls the cursor —
   resuming old provider history into a visually empty thread. The window is
   narrow (reactor normally runs within milliseconds) but it silently defeats
   the feature's core guarantee. Fix options: process the clear synchronously
   before command ack, or have the provider start path check for an unprocessed
   clear. Not addressed in the initial implementation.

## Implementation order

1. `packages/contracts` — command, event, payload schemas, capability flag.
2. `decider.ts` — `thread.clear` case with the in-flight guard.
3. `projector.ts` — `thread.cleared` case.
4. Reactor — session teardown, `resumeCursor: null` upsert, checkpoint cleanup,
   fresh baseline.
5. `apps/web` — `attemptClear`, confirm dialog, single-row context-menu item,
   capability gate, in-flight gate.
6. Verify: clear → new turn → confirm the agent has no memory of prior turns;
   confirm `git status` is unchanged across the clear; confirm a projection
   rebuild from the event log stays cleared.

## Estimate

Larger than the drag-reorder work — this crosses contracts, decider, projector, a
reactor, the provider directory, and the client. The contracts/decider/projector
part is mechanical (~a day); the reactor and per-adapter cursor verification is
where the real time goes.
