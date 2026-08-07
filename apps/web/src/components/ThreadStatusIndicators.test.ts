import type { ThreadLinkedPullRequest, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prStatusIndicator,
  linkedPullRequestToThreadPr,
  resolveThreadPr,
  resolveThreadPullRequest,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

describe("resolveThreadPr", () => {
  it("keeps local-checkout PR indicators scoped to the stored thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "feature/other",
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("hides PR indicators when a dedicated worktree has switched away from the thread branch", () => {
    expect(
      resolveThreadPr({
        threadBranch: "stack/base",
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("hides PR indicators when thread branch metadata is missing", () => {
    expect(
      resolveThreadPr({
        threadBranch: null,
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("shows the PR when the live checkout matches the stored thread branch", () => {
    const gitStatus = status();

    expect(
      resolveThreadPr({
        threadBranch: "feature/current",
        gitStatus,
      }),
    ).toBe(gitStatus.pr);
  });
});

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/v2-row:${colorClass}`);
  });
});

const LINK: ThreadLinkedPullRequest = {
  number: 7,
  url: "https://github.com/pingdotgg/t3code/pull/7",
  title: "Linked PR",
  headBranch: "feature/linked",
  baseBranch: "main",
  state: "open",
  cwd: "/repo",
  linkedAt: "2026-08-01T00:00:00.000Z",
  linkedBy: "user",
  refreshedAt: "2026-08-01T00:00:00.000Z",
};

describe("resolveThreadPullRequest", () => {
  it("infers from the branch in auto mode, ignoring any link", () => {
    expect(
      resolveThreadPullRequest({
        mode: "auto",
        linkSupported: true,
        threadBranch: "feature/current",
        linkedPullRequest: LINK,
        gitStatus: status(),
      })?.number,
    ).toBe(42);
  });

  it("returns the linked PR in manual mode even when the branch matches another", () => {
    expect(
      resolveThreadPullRequest({
        mode: "manual",
        linkSupported: true,
        threadBranch: "feature/current",
        linkedPullRequest: LINK,
        gitStatus: status(),
      })?.number,
    ).toBe(7);
  });

  it("shows no PR in manual mode when nothing is linked", () => {
    // The mismatch this whole mode exists to prevent: a branch-matched PR
    // must not appear on a thread the user never linked it to.
    expect(
      resolveThreadPullRequest({
        mode: "manual",
        linkSupported: true,
        threadBranch: "feature/current",
        linkedPullRequest: null,
        gitStatus: status(),
      }),
    ).toBeNull();
  });

  it("falls back to inference when the server cannot store links", () => {
    expect(
      resolveThreadPullRequest({
        mode: "manual",
        linkSupported: false,
        threadBranch: "feature/current",
        linkedPullRequest: null,
        gitStatus: status(),
      })?.number,
    ).toBe(42);
  });

  it("maps a link onto the same shape an inferred PR uses", () => {
    expect(linkedPullRequestToThreadPr(LINK)).toEqual({
      number: 7,
      title: "Linked PR",
      url: "https://github.com/pingdotgg/t3code/pull/7",
      baseRef: "main",
      headRef: "feature/linked",
      state: "open",
    });
  });
});
