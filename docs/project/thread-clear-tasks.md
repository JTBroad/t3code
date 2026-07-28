# Task guide: clear a thread in place

Work top to bottom — later steps depend on earlier ones compiling.
**No tests in this pass.** Do not add new test files and do not modify existing
ones, except where a step explicitly says a type fixture needs a field.

Reference spec: `docs/project/thread-clear.md`
Branch: `thread-clear`

**The one thing to keep in mind throughout:** clearing has two halves. Step 4
clears what the _UI_ shows. Step 6 clears what the _agent_ remembers. Shipping
step 4 without step 6 produces a thread that looks empty but still has full
memory — that's the bug this whole feature exists to avoid.

Bash paths differ from editor paths: the repo is at
`/sessions/eager-compassionate-cerf/mnt/t3code` in the shell.

Typecheck with `cd apps/web && node_modules/.bin/tsc --noEmit` (or
`pnpm --filter t3 typecheck` if pnpm is on your PATH). Five pre-existing errors
in `apps/web/src/observability/clientTracing.ts` are expected and unrelated —
introduce no new ones.

---

## Step 1 — Contracts: command, event, payload

File: `packages/contracts/src/orchestration.ts`

- [x] Add `ThreadClearCommand` next to `ThreadSettleCommand` (~line 579). Fields:
      `type: Schema.Literal("thread.clear")`, `commandId: CommandId`,
      `threadId: ThreadId`, `createdAt: IsoDateTime`.
- [x] Register it in **both** `DispatchableClientOrchestrationCommand` and
      `ClientOrchestrationCommand` unions.
- [x] Add `"thread.cleared"` to the event-type string union (~line 884, the list
      containing `"thread.settled"`, `"thread.snoozed"`, …).
- [x] Add `ThreadClearedPayload` next to `ThreadSettledPayload` (~line 971).
      Fields: `threadId: ThreadId`, `clearedAt: IsoDateTime`.
- [x] Add the event struct to the event union (~line 1167 area), following the
      `thread.settled` entry exactly:
      `Schema.Struct({ ...EventBaseFields, type: Schema.Literal("thread.cleared"), payload: ThreadClearedPayload })`.

**Done when:** `packages/contracts` typechecks and `ThreadClearedPayload` is
exported.

---

## Step 2 — Contracts: capability flag

File: `packages/contracts/src/environment.ts`

- [x] Add `threadClear: Schema.optionalKey(Schema.Boolean)` to
      `ExecutionEnvironmentCapabilities` (~line 40), beside `threadSnooze`.
- [x] Copy the doc-comment pattern from `threadSettlement`: absent means
      unsupported, so clients under version skew never send the command.

File: `apps/server/src/environment/ServerEnvironment.ts`

- [x] Add `threadClear: true` to the advertised capabilities (~line 143, where
      `threadSettlement: true` lives).

**Done when:** both packages typecheck.

---

## Step 3 — Server: decider case

File: `apps/server/src/orchestration/decider.ts`

- [x] Add `case "thread.clear":` after the `thread.unsnooze` case (~line 606).
- [x] Guards, in order: 1. Thread must exist and have `deletedAt === null` — copy the lookup shape
      used by `thread.settle` (~line 448). 2. **Refuse while a turn is in flight.** Read how `thread.turn.start`
      (~line 713) uses `hasOpenBlockingRequest` and
      `threadHasQueuedTurnStart`, and refuse if the thread has an active turn
      or a queued turn start. Clearing mid-turn would let the adapter write
      results into a projection with no turn to attach them to.
- [x] Emit a single `thread.cleared` event with
      `payload: { threadId, clearedAt: occurredAt }`, using `withEventBase`.
- [x] Idempotent by re-emission: clearing an already-empty thread still emits.
      The settle case documents this pattern — match its comment style.

**Done when:** `apps/server` typechecks.

---

## Step 4 — Server: projector case (clears the UI)

File: `apps/server/src/orchestration/Schemas.ts`

- [x] Re-export `ThreadClearedPayload` from contracts, matching how
      `ThreadSettledPayload` is re-exported (~line 36).

File: `apps/server/src/orchestration/projector.ts`

- [x] Add `case "thread.cleared":` — read the `thread.reverted` case (~line 670)
      first; this is the same idea with nothing retained.
- [x] Set `messages: []`, `activities: []`, `proposedPlans: []`,
      `checkpoints: []`, `latestTurn: null`, `updatedAt: event.occurredAt`.
- [x] Leave **every** other field alone: `title`, `modelSelection`,
      `runtimeMode`, `interactionMode`, `branch`, `worktreePath`, `createdAt`,
      `archivedAt`, `snoozedUntil`, `session`, and — deliberately —
      `settledOverride` / `settledAt`. Clearing is not activity; the existing
      activity-based unsettle rules handle the next turn.
- [x] Add a short comment saying this projection is only half the clear, and
      that the provider resume cursor is dropped by the reactor in
      `ThreadClearReactor`.

**Done when:** `apps/server` typechecks.

---

## Step 5 — Server: reactor service interface

File: `apps/server/src/orchestration/Services/ThreadClearReactor.ts` (new)

- [x] Copy the shape of
      `apps/server/src/orchestration/Services/ThreadDeletionReactor.ts` — read it
      first; it is short and this file should mirror it closely.
- [x] Export a `ThreadClearReactor` `Context.Service` and a
      `ThreadClearReactorShape`.

**Done when:** the file typechecks in isolation.

---

## Step 6 — Server: reactor implementation (clears the agent's memory)

File: `apps/server/src/orchestration/Layers/ThreadClearReactor.ts` (new)

Model this on `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`
(99 lines — read the whole thing first). It already demonstrates the
`makeDrainableWorker` + `logCleanupCauseUnlessInterrupted` + `processXSafely`
pattern you want.

On each `thread.cleared` event, in order:

- [x] **Stop the live provider session** via `providerService.stopSession({ threadId })`,
      wrapped in `logCleanupCauseUnlessInterrupted`. The in-memory adapter
      context holds `turns`, `pendingApprovals`, `pendingUserInputs`, and
      `resumeSessionId` — all of it must go.
- [x] **Null the persisted resume cursor.** Read the current binding with
      `directory.getBinding(threadId)`, then
      `directory.upsert({ ...binding, resumeCursor: null })`.

      This is the single most important line in the feature. In
      `ClaudeAdapter.startSession` (~line 3169):
      ```ts
      const existingResumeSessionId = resumeState?.resume;
      const newSessionId = existingResumeSessionId === undefined ? yield* randomUUIDv4 : undefined;
      ```
      A fresh session is only generated when `resume` is absent. If the cursor
      survives, the next turn resumes the provider's own server-side history and
      the "cleared" thread still remembers everything.

      Note `ProviderSessionDirectoryShape` has **no delete** — only `upsert`,
      `getProvider`, `getBinding`, `listThreadIds`, `listBindings`. Nulling is
      the only route. Verify the persistence layer under
      `Layers/ProviderSessionDirectory.ts` actually stores the null rather than
      treating it as "no change"; `ProviderService` distinguishes null from
      undefined (~line 369), which is a good sign but is not proof.

      Do **not** call `adapter.rollbackThread` as a substitute. It splices
      `context.turns` and rewrites the cursor, but that rewrite preserves
      `context.resumeSessionId`, so `resume` survives.

- [x] **Delete the thread's checkpoint refs** via
      `checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs })`. The
      projection just dropped them; leaving them on disk orphans them.
      `CheckpointReactor.handleRevertRequested` does this for the stale subset —
      copy that call shape.

      **Do NOT call `checkpointStore.restoreCheckpoint`.** That is the
      filesystem revert we are deliberately not doing. The user's working tree
      must be untouched by a clear.

- [x] **Capture a fresh turn-0 baseline** so a later revert has a target. The
      baseline-capture path already exists in `CheckpointReactor` (search
      `checkpoint.baseline.captured`). After a clear, turn 0 is the _current_
      working tree, not the tree at thread creation — that is the intended
      semantic given we keep file changes.

File: `apps/server/src/server.ts`

- [x] Import `ThreadClearReactorLive` and add it to `ReactorLayerLive`
      (~line 165) alongside `ThreadDeletionReactorLive`.

**Done when:** `apps/server` typechecks and the layer is wired.

---

## Step 7 — Client runtime: the command

File: `packages/client-runtime/src/operations/commands.ts`

- [x] Add `export type ClearThreadInput = CommandInput<"thread.clear">;` beside
      `SettleThreadInput` (~line 38).
- [x] Add a `clearThread` operation copying `settleThread` (~line 160) verbatim,
      swapping the literal to `"thread.clear"`. (Note: `thread.clear` carries a
      required `createdAt`, so it uses the `timestampedCommandMetadata` shape
      rather than settle's bare `commandId` shape.)

File: `packages/client-runtime/src/state/threadCommands.ts`

- [x] Import `clearThread` and `ClearThreadInput`, then add a `clear:` entry to
      the command record following the `settle:` entry (~line 97). Label:
      `"environment-data:commands:thread:clear"`.

**Done when:** `packages/client-runtime` typechecks.

---

## Step 8 — Web: the action hook

File: `apps/web/src/hooks/useThreadActions.ts`

- [x] Add `const clearThreadMutation = useAtomCommand(threadEnvironment.clear, { reportFailure: false });`
      beside the settle/snooze mutations (~line 108).
- [x] Export a `clearThread` callback from the hook, following the shape of the
      existing settle/snooze exports.

**Done when:** `apps/web` typechecks.

---

## Step 9 — Web: sidebar context menu item

File: `apps/web/src/components/SidebarV2.tsx`

- [x] Pull `clearThread` out of the `useThreadActions()` destructure (~line 1087).
- [x] Add an `attemptClear` callback modeled on `attemptSettle` (~line 1895):
      double-dispatch guard via a `clearingThreadKeysRef` set, `await` the
      command, and on `result._tag === "Failure"` (and not
      `isAtomCommandInterrupted`) raise a `stackedThreadToast` with title
      `"Failed to clear thread"`.
- [x] In the **single-row** context menu (`handleThreadContextMenu`, ~line 2103
      handles the results; the item array is built just above), add
      `{ id: "clear", label: "Clear thread" }` positioned **between**
      `mark-unread` and `delete`.
- [x] Gate the item on capability: only include it when
      `serverConfigs.get(thread.environmentId)?.environment.capabilities.threadClear === true`,
      matching how `snoozeSupported` is computed.
- [x] Gate the item on in-flight state too: omit it when the thread's
      `session?.status` is `"running"` or `"starting"`. The decider will refuse
      those anyway — don't offer a doomed command.
- [x] Add the result branch: on `clicked.value === "clear"`, show the confirm
      dialog (next step), then call `attemptClear`.
- [x] Do **not** add clear to `handleMultiSelectContextMenu`. Single-row only
      this pass.

**Done when:** `apps/web` typechecks.

---

## Step 10 — Web: confirm dialog

File: `apps/web/src/components/SidebarV2.tsx`

- [x] Before dispatching, `await api.dialogs.confirm(...)` and bail on
      `confirmed._tag === "Failure" || !confirmed.value`. Copy the exact shape
      from the delete branch (~line 2113).
- [x] Copy:
      `     Clear this thread?
    The conversation and the agent's memory of it are removed. Your file changes are kept.
    `
      The second line matters — the file-safety promise is the whole reason a
      user would pick clear over delete.
- [x] **Always confirm.** Do not gate this on the `confirmThreadDelete` client
      setting and do not add a sibling setting. There is no undo: the transcript
      is gone from the projection and the provider session id is unrecoverable,
      so the toast-with-Undo pattern used by snooze is not available.

**Done when:** `apps/web` typechecks.

---

## Final check (no tests)

- [x] Typecheck clean across `packages/contracts`, `packages/client-runtime`,
      `apps/server`, `apps/web` — only the 5 pre-existing `clientTracing.ts`
      errors remain.
      _Verified with fresh (non-incremental) `tsc --noEmit` and `tsgo --noEmit`
      per package: all four exit 0 with zero diagnostics. The 5 `clientTracing.ts`
      errors the guide expected no longer reproduce._
- [x] `pnpm lint` and `vp fmt --check` on touched files.
      _`vp fmt --check` on all 14 touched files: clean. `vp lint` could not be
      run — oxlint panics in the sandbox
      (`oxc_allocator/src/pool/fixed_size.rs:112` unwrap on `Err`), with
      `--threads 1` as well. Lint is UNVERIFIED._
- [x] `git diff` review: no changes to `CheckpointReactor`'s revert path, no call
      to `restoreCheckpoint` anywhere in the new reactor, nothing under
      `apps/mobile`, no test files modified.
      _All four confirmed. `restoreCheckpoint` appears in the new reactor only
      inside a comment explaining why it is not called._

### Open gaps found during the wiring trace

- [x] `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` has no
      `thread.cleared` case. That pipeline owns the durable SQL projection
      (messages / activities / proposed plans / turns) that
      `ProjectionSnapshotQuery` reads and `ws.ts` serves to clients; its switch
      ends in `default: return`, so a clear is silently dropped and the
      transcript survives. `thread.reverted` is handled in five of its
      projectors — mirror those.
- [x] `packages/client-runtime/src/state/threadReducer.ts` has no
      `thread.cleared` case, so `applyThreadDetailEvent` falls through to
      `{ kind: "unchanged" }` and an open thread does not clear live.
- [ ] `ThreadClearReactor.start()` is called from `serverRuntimeStartup.ts`
      rather than from `OrchestrationReactor` (`Layers/OrchestrationReactor.ts`),
      where every sibling reactor including `ThreadDeletionReactor` is started.
      Fine for the real server, but any other entrypoint that starts only
      `OrchestrationReactor` (e.g.
      `apps/server/integration/OrchestrationEngineHarness.integration.ts`) never
      starts the clear reactor.
