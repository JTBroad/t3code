# Spec: Drag-reorderable threads in Sidebar v2

Status: proposal · Branch: `drag-reorder-v2-threads`

## Goal

Let the user drag thread cards in the v2 left sidebar into an arbitrary order and
have that order persist, instead of being locked to creation order.

## Verdict

Nothing blocks this. The building blocks already exist in the repo:

- `@dnd-kit/{core,sortable,modifiers,utilities}` are already dependencies of
  `apps/web` and are already used for **project** drag-reorder in the v1 sidebar
  (`Sidebar.tsx`: `DndContext` + `SortableContext` + `SortableProjectItem`,
  `PointerSensor` with `activationConstraint: { distance: 6 }`,
  `restrictToVerticalAxis` + `restrictToFirstScrollableAncestor`).
- Persistence precedent: `uiStateStore.ts` stores `projectOrder: string[]` in
  localStorage (`t3code:ui-state:v1`) with a `reorderProjects` reducer that
  already handles multi-item drags.
- Order application precedent: `orderItemsByPreferredIds()` in
  `Sidebar.logic.ts` merges a preferred-id list with a live item list.
- The v2 active list is already **positionally stable** — `sortThreadsForSidebarV2`
  sorts by `createdAt` only, and activity never reorders rows. So a manual order
  won't fight live updates. Manual order is a natural extension of that design
  intent, not a fight with it.

## Current behavior (apps/web/src/components/SidebarV2.tsx)

Threads are partitioned into three sections in one `<ul>`:

| Section | Source of order                                              |
| ------- | ------------------------------------------------------------ |
| active  | `sortThreadsForSidebarV2` — `createdAt` desc, `id` tiebreak  |
| snoozed | `snoozedUntil` asc (soonest wake first)                      |
| settled | `sortSettledThreadsForSidebarV2` — settle/last-activity desc |

`orderedThreadKeys` (`[...active, ...visibleSnoozed, ...renderedSettled]`) drives
`cmd+1..9` jump hints and prev/next traversal, so it picks up any new order for
free.

## Design

### Scope

Manual order applies to the **active** section only. Snoozed sorts by wake time
and settled is history ordered by when work ended; both have a meaning position
already encodes. Cross-section drags are disallowed (a separate `SortableContext`
per section, or simply only wrapping the active items).

### Identity key

Order entries are `scopedThreadKey` (`environmentId:threadId`), not bare thread
ids — the sidebar is multi-environment and ids are only unique per environment.

### Ordering semantics

`orderItemsByPreferredIds` puts **unknown ids last**. That's wrong here: a newly
created thread must appear at the top, not the bottom. Add a sibling helper
(e.g. `orderThreadsByPreferredKeys`) that emits unknown items **first**, in their
default `sortThreadsForSidebarV2` order, then the pinned manual sequence. Cover
with cases in `Sidebar.logic.test.ts`.

Alternative considered: write the full order eagerly on thread creation. Rejected
— it makes every thread create a persisted-state write and races with multi-client
creation.

### Persistence

Add `threadOrder: string[]` to `PersistedUiState` / `UiState` in `uiStateStore.ts`,
mirroring `projectOrder` (sanitized by `sanitizeStringArray`, debounced write).

Two open decisions:

1. **localStorage vs. synced client settings.** `projectOrder` is localStorage
   (per-device). `ClientSettingsSchema` in `packages/contracts/src/settings.ts` is
   the synced alternative (that's where `sidebarProjectSortOrder`,
   `sidebarV2Enabled` etc. live). Recommendation: start in localStorage for
   symmetry and zero contract/server change; promote later if cross-device order
   is requested.
2. **Growth/pruning.** Threads churn far harder than projects, so `threadOrder`
   grows unbounded. Prune keys that (a) are absent from the live thread stream
   **and** (b) belong to a currently-connected environment — never prune keys for
   an environment that's offline, or reconnecting wipes the user's order. Cap the
   list length as a backstop.

### Reducer

`reorderThreads(state, currentOrder, draggedKeys, targetKeys)` — copy
`reorderProjects` verbatim; it already handles the multi-select case correctly
(removal-before-target index compensation). Threads support multi-select
(`useThreadSelectionStore`), so dragging a selection should move the whole
selection, matching v1 project behavior.

### Opt-in

Two options:

- **Implicit** — the first drag switches the active section into manual mode; a
  "Reset order" item in the sidebar options menu clears `threadOrder`.
- **Explicit** — a `sidebarThreadSortOrder: "manual"` mode, matching the existing
  `sidebarProjectSortOrder: "manual"` pattern in contracts.

Recommendation: implicit. The v2 active list has no competing sort mode, so a mode
switch is ceremony; a reset action covers the escape hatch.

## Risks / things to get right

1. **Gesture collisions.** Rows already own click-to-navigate, double-click-to-
   rename (`isTrailingDoubleClick`), shift/cmd multi-select, and right-click
   context menu. Reuse v1's `distance: 6` activation constraint plus its
   `dragInProgressRef` / `suppressClickAfterDrag` refs so a drag doesn't fire a
   navigation on release.
2. **Section headers live in the same `<ul>`.** The "Snoozed" / "Settled" header
   `<li>`s are siblings of the rows. `SortableContext items` must contain only
   active thread keys, and `restrictToFirstScrollableAncestor` should keep the
   drag inside the scroller.
3. **Per-variant keys and FLIP.** Rows are keyed `${threadKey}:${rowVariant}` on
   purpose to avoid cross-section slide animations. Applying dnd-kit transforms
   must not reintroduce that — verify a settle-during-drag doesn't produce a
   ghost.
4. **Project-scoped view.** When `scopedProjectKeys` filters the list, a single
   global order list still works (missing keys are skipped), but reordering inside
   a filtered view must not scramble hidden threads — splice relative to the
   filtered target's position in the global list.
5. **Mobile.** `apps/mobile/src/features/threads/threadListV2.ts` is a separate
   implementation. Out of scope unless we want parity; if so, order should move to
   synced client settings.
6. **Keyboard.** `cmd+1..9` follows `orderedThreadKeys`, so hints track the manual
   order automatically — add a regression test so this stays true.

## Implementation plan

1. `uiStateStore.ts` — add `threadOrder` state, persistence, `reorderThreads`
   reducer, `pruneThreadOrder`; tests in `uiStateStore.test.ts`.
2. `Sidebar.logic.ts` — add `orderThreadsByPreferredKeys` (unknown-first);
   tests in `Sidebar.logic.test.ts`.
3. `SidebarV2.tsx` — apply the manual order to `activeThreads`; wrap the active
   rows in `DndContext` + `SortableContext`; add `useSortable` to `SidebarV2Row`
   (card variant only) with the drag-suppression refs.
4. Sidebar options menu — "Reset thread order" (enabled only when `threadOrder`
   is non-empty).
5. Prune on thread-stream change, guarded by environment connectivity.
6. Verify: `pnpm typecheck`, `pnpm test`, manual pass on drag + navigate, drag +
   settle, drag under project scoping, new-thread-goes-to-top, reload persistence.

## Estimate

Roughly 400–600 lines across 4 files plus tests. The dnd-kit wiring is a port of
existing v1 code; the genuinely new work is unknown-first ordering and pruning.
