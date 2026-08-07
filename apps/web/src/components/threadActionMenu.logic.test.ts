import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  linkedPullRequestNumber: null,
  changeRequestName: "pull request",
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toEqual(["rename", "mark-unread", "copy-path", "delete"]);
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = ids({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(ids(baseState)).not.toContain("new-thread-on-branch");
    expect(ids(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
});

describe("pull request linking items", () => {
  it("omits the actions on surfaces that have not wired linking up", () => {
    expect(ids(baseState)).not.toContain("link-pull-request");
  });

  it("offers a single link action when no PR is linked", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      supports: { ...baseState.supports, pullRequestLink: true },
    });
    expect(items.map((item) => item.id)).toContain("link-pull-request");
    expect(items.map((item) => item.id)).not.toContain("unlink-pull-request");
    expect(items.find((item) => item.id === "link-pull-request")?.label).toBe("Link pull request…");
  });

  it("names the linked PR so unlinking says what it detaches", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      linkedPullRequestNumber: 42,
      supports: { ...baseState.supports, pullRequestLink: true },
    });
    expect(items.map((item) => item.id)).not.toContain("link-pull-request");
    expect(items.find((item) => item.id === "unlink-pull-request")?.label).toBe(
      "Unlink pull request #42",
    );
    expect(items.find((item) => item.id === "relink-pull-request")?.label).toBe(
      "Change linked pull request (#42)…",
    );
  });

  it("uses the host's terminology", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      changeRequestName: "merge request",
      supports: { ...baseState.supports, pullRequestLink: true },
    });
    expect(items.find((item) => item.id === "link-pull-request")?.label).toBe(
      "Link merge request…",
    );
  });
});
