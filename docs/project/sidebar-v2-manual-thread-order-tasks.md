# Task guide: drag-reorderable threads in Sidebar v2

Work top to bottom. Each step is self-contained and should typecheck on its own.
**No tests in this pass** — test coverage is handled separately at the end.

Reference spec: `docs/project/sidebar-v2-manual-thread-order.md`

---

## Step 1 — Add `threadOrder` to the UI state store

File: `apps/web/src/uiStateStore.ts`

- [x] Add `threadOrder?: string[]` to `PersistedUiState` and `threadOrder: string[]`
      to `UiProjectState`'s sibling — put it on a new `UiThreadOrderState` interface
      (or extend `UiThreadState`) and include it in `UiState`.
- [x] Add `threadOrder: []` to `initialState`.
- [x] Parse it in `parsePersistedState` with `sanitizeStringArray(parsed.threadOrder)`.
- [x] Write it out in `persistState` alongside `projectOrder`.
- [x] Add a `reorderThreads(state, currentThreadOrder, draggedThreadKeys, targetThreadKeys)`
      pure reducer. Copy the body of `reorderProjects` exactly — the
      removal-before-target index compensation is what makes multi-select drags
      land correctly.
- [x] Add `pruneThreadOrder(state, liveThreadKeys, prunableEnvironmentIds)`:
      drop entries whose key is absent from `liveThreadKeys` **only when** the
      key's `environmentId` prefix is in `prunableEnvironmentIds`. Keys are
      `"<environmentId>:<threadId>"`. Return `state` unchanged when nothing drops.
- [x] Add `clearThreadOrder(state)` returning `{ ...state, threadOrder: [] }`
      (no-op when already empty).
- [x] Wire `reorderThreads`, `pruneThreadOrder`, `clearThreadOrder` into the
      `UiStateStore` interface and the `create<UiStateStore>` body, matching how
      `reorderProjects` is wired.

**Done when:** `pnpm --filter t3 typecheck` passes and nothing else references the
new fields yet.

---

## Step 2 — Add unknown-first ordering helper

File: `apps/web/src/components/Sidebar.logic.ts`

- [x] Add `orderThreadsByPreferredKeys<T>({ items, preferredKeys, getKey })`.
- [x] Semantics: items whose key is **not** in `preferredKeys` come **first**, in
      their incoming order (callers pass the already-default-sorted array). Then
      items whose key is in `preferredKeys`, in `preferredKeys` order. Keys in
      `preferredKeys` with no matching item are skipped.
- [x] Do **not** modify `orderItemsByPreferredIds` — projects depend on its
      unknown-last behavior.
- [x] Document the unknown-first choice in a short comment: a newly created thread
      must appear at the top of the active list, not the bottom.

**Done when:** typecheck passes; the function is exported and unused so far.

---

## Step 3 — Apply the manual order to the active list

File: `apps/web/src/components/SidebarV2.tsx`

- [x] Read `threadOrder` from `useUiStateStore`.
- [x] After the existing `activeThreads` memo, derive
      `orderedActiveThreads = orderThreadsByPreferredKeys({ items: activeThreads,
    preferredKeys: threadOrder, getKey: thread => scopedThreadKey(scopeThreadRef(...)) })`.
- [x] Replace every render/derivation use of `activeThreads` with
      `orderedActiveThreads` — including the `orderedThreadKeys` memo (line ~1514)
      so `cmd+1..9` jump hints and prev/next traversal follow the manual order.
- [x] Leave `snoozedThreads` and `settledThreads` untouched.

**Done when:** typecheck passes and the sidebar renders identically (order is
empty, so behavior is unchanged).

---

## Step 4 — Make active rows sortable

Files: `apps/web/src/components/SidebarV2.tsx`

- [x] Add a `SortableThreadItem` wrapper modeled on `SortableProjectItem` in
      `Sidebar.tsx` (lines ~2691-2725): `useSortable({ id: threadKey })`,
      `CSS.Translate.toString(transform)`, `transition`, `isDragging` →
      `z-20 opacity-80`, `isOver && !isDragging` → `ring-1 ring-primary/40`.
- [x] Wrap **only** `section === "active"` rows in it. Snoozed and settled rows
      render exactly as they do today.
- [x] Wrap the `<ul>` contents in `<DndContext>` with: - `sensors`: `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))` - `modifiers`: `[restrictToVerticalAxis, restrictToFirstScrollableAncestor]` - `collisionDetection`: same `pointerWithin`-first callback used in `Sidebar.tsx`
- [x] `<SortableContext items={...} strategy={verticalListSortingStrategy}>` must
      receive **only active thread keys** — the "Snoozed"/"Settled" header `<li>`s
      are siblings in the same `<ul>` and must not be sortable.
- [x] Preserve the existing `key={`${threadKey}:${rowVariant}`}` on rows. Do not
      collapse the per-variant key — it exists to stop cross-section FLIP slides.

**Done when:** typecheck passes and rows visibly drag (they won't persist yet).

---

## Step 5 — Commit the drag and suppress the trailing click

File: `apps/web/src/components/SidebarV2.tsx`

- [x] Add `dragInProgressRef` and `suppressThreadClickAfterDragRef` refs, mirroring
      `dragInProgressRef` / `suppressProjectClickAfterDragRef` in `Sidebar.tsx`.
- [x] `onDragStart`: set `dragInProgressRef.current = true`.
- [x] `onDragEnd`: resolve dragged keys — if the dragged row is part of the current
      `useThreadSelectionStore` selection, drag the whole selection; otherwise just
      the one row. Call `reorderThreads(threadOrder, draggedKeys, [overKey])`.
      Then set `suppressThreadClickAfterDragRef.current = true` and clear
      `dragInProgressRef`.
- [x] `onDragCancel`: clear both refs.
- [x] In the row click handler, early-return (and reset the suppress flag) when
      `suppressThreadClickAfterDragRef.current` is set, so releasing a drag does
      not navigate. Same guard shape as `Sidebar.tsx` lines ~1354-1362.
- [x] Seed `threadOrder` on first drag: if `threadOrder` is empty, initialize it
      from the current `orderedActiveThreads` keys before applying the move, so
      the first drag has a stable baseline to splice into.

**Done when:** dragging a card persists across reload, and click-to-navigate still
works on a plain click.

---

## Step 6 — Prune stale entries

File: `apps/web/src/components/SidebarV2.tsx`

- [x] In an effect keyed on the live thread list, compute the set of live
      `scopedThreadKey`s across **all** sections (active + snoozed + settled, not
      just visible ones) and the set of environment ids that are currently
      connected (`serverConfigs` / `useEnvironments` already available in this file).
- [x] Call `pruneThreadOrder(liveKeys, connectedEnvironmentIds)`.
- [x] Guard: if the connected-environment set is empty, skip pruning entirely —
      a transient disconnect must never wipe the user's order.

**Done when:** deleting a thread removes its key from persisted state, and
disconnecting an environment leaves its keys intact.

---

## Step 7 — Reset action

File: `apps/web/src/components/SidebarV2.tsx`

- [x] Add a "Reset thread order" item to the sidebar options menu (the same menu
      that hosts the grouping-mode controls in v2).
- [x] Disable it when `threadOrder.length === 0`.
- [x] On click, call `clearThreadOrder()`; the active list falls back to
      `sortThreadsForSidebarV2` creation order automatically.

**Done when:** the menu item restores creation order and greys out afterward.

---

## Final check (no tests)

- [x] `pnpm --filter t3 typecheck` clean — only the 5 pre-existing
      `src/observability/clientTracing.ts` errors remain (unrelated to this branch).
      Fixed one type break this branch caused: the `makeUiState` fixture in
      `uiStateStore.test.ts` needed the new required `threadOrder: []` field.
- [x] `pnpm lint` on the touched files — formatter (`vp fmt`) clean after
      reformatting `SidebarV2.tsx` and `uiStateStore.ts`. `vp lint`/oxlint could not
      be executed in the sandbox (oxc allocator panic), so lint is unverified there.
- [x] `git diff` reviewed — no changes to `Sidebar.tsx` v1 behavior, no changes to
      `orderItemsByPreferredIds`, no changes under `apps/mobile`
