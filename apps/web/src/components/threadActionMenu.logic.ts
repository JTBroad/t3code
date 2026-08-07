import type { ContextMenuItem } from "@t3tools/contracts";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "link-pull-request"
  | "relink-pull-request"
  | "unlink-pull-request"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "copy-path"
  | "copy-branch"
  | "clear"
  | "delete";

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** The PR currently linked to this thread, or null. Drives link vs.
      change/unlink, and puts the number in the label so the menu says which
      PR would be detached. */
  readonly linkedPullRequestNumber: number | null;
  /** Terminology for the host (pull request / merge request), so the label
      does not say "pull request" on a GitLab project. */
  readonly changeRequestName: string;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
    /**
     * Optional: surfaces that have not wired up clearing omit it entirely
     * rather than passing `false`, so adding the action to a new menu is a
     * deliberate act instead of something a default silently turns on.
     */
    readonly clear?: boolean;
    /**
     * Optional for the same reason as `clear`. Note this is capability-only:
     * the actions show in BOTH link modes. Auto mode still benefits from
     * pinning down a thread whose branch guessed wrong, and a link made in
     * auto mode is what makes switching to manual non-destructive.
     */
    readonly pullRequestLink?: boolean;
  };
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu both render exactly this list, so labels,
 * ordering, and capability gating cannot drift between the two surfaces.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread" }
            : { id: "pin" as const, label: "Pin thread" },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread" }
            : { id: "settle" as const, label: "Settle thread" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                disabled: !state.canSnoozeNow,
                children: state.snoozePresets.map((preset) => ({
                  id: `snooze:${preset.id}` as const,
                  label: `${preset.label} (${preset.whenLabel})`,
                })),
              },
        ]
      : []),
    ...(state.supports.pullRequestLink
      ? state.linkedPullRequestNumber === null
        ? [{ id: "link-pull-request" as const, label: `Link ${state.changeRequestName}…` }]
        : [
            {
              id: "relink-pull-request" as const,
              label: `Change linked ${state.changeRequestName} (#${state.linkedPullRequestNumber})…`,
            },
            {
              id: "unlink-pull-request" as const,
              label: `Unlink ${state.changeRequestName} #${state.linkedPullRequestNumber}`,
            },
          ]
      : []),
    { id: "rename", label: "Rename thread" },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread" },
    { id: "copy-path", label: "Copy path", icon: "copy" },
    ...(state.branch ? [{ id: "copy-branch" as const, label: "Copy branch", icon: "copy" }] : []),
    ...(state.supports.clear ? [{ id: "clear" as const, label: "Clear thread" }] : []),
    { id: "delete", label: "Delete", destructive: true, icon: "trash" },
  ];
}
