import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  getThreadsReturnPath,
  isMemoryWorkspacePath,
  isReturnablePath,
  rememberThreadsPath,
  resetThreadsReturnPathForTest,
  resolveThreadsHref,
  THREADS_WORKSPACE_ROOT,
} from "./WorkspaceRail.logic";

const THREAD_PATH = "/local/th_9f2c";

beforeEach(() => {
  resetThreadsReturnPathForTest();
});

describe("isMemoryWorkspacePath", () => {
  it("matches the memory route and its children", () => {
    expect(isMemoryWorkspacePath("/memory")).toBe(true);
    expect(isMemoryWorkspacePath("/memory/notes")).toBe(true);
  });

  it("does not match a route that merely starts with the same letters", () => {
    expect(isMemoryWorkspacePath("/memorable")).toBe(false);
  });

  it("treats settings as part of the Threads workspace", () => {
    expect(isMemoryWorkspacePath("/settings/general")).toBe(false);
  });
});

describe("return path", () => {
  it("defaults to the thread list before anything is remembered", () => {
    expect(getThreadsReturnPath()).toBe(THREADS_WORKSPACE_ROOT);
  });

  it("remembers the open thread", () => {
    rememberThreadsPath(THREAD_PATH);
    expect(getThreadsReturnPath()).toBe(THREAD_PATH);
  });

  it("never remembers a memory route", () => {
    // Otherwise the Threads button would point back into Memory.
    rememberThreadsPath(THREAD_PATH);
    rememberThreadsPath("/memory");
    expect(getThreadsReturnPath()).toBe(THREAD_PATH);
  });

  it("never remembers an auth route", () => {
    // Returning to one would drop the user into a screen they already cleared.
    rememberThreadsPath(THREAD_PATH);
    for (const path of ["/pair", "/connect", "/connect/callback"]) {
      rememberThreadsPath(path);
    }
    expect(getThreadsReturnPath()).toBe(THREAD_PATH);
  });

  it("keeps the most recent thread when several are visited", () => {
    rememberThreadsPath(THREAD_PATH);
    rememberThreadsPath("/local/th_other");
    expect(getThreadsReturnPath()).toBe("/local/th_other");
  });

  it("accepts settings as a return target", () => {
    rememberThreadsPath("/settings/general");
    expect(getThreadsReturnPath()).toBe("/settings/general");
  });
});

describe("isReturnablePath", () => {
  it("rejects anything that is not an absolute path", () => {
    expect(isReturnablePath("memory")).toBe(false);
    expect(isReturnablePath("")).toBe(false);
  });
});

describe("resolveThreadsHref", () => {
  it("returns to the remembered thread when leaving Memory", () => {
    // The bug this exists for: a static "/" is the new-thread starter, so a
    // round trip through Memory silently dropped the open thread.
    rememberThreadsPath(THREAD_PATH);
    expect(resolveThreadsHref("/memory")).toBe(THREAD_PATH);
  });

  it("stays on the thread list while already in Threads", () => {
    rememberThreadsPath(THREAD_PATH);
    expect(resolveThreadsHref(THREAD_PATH)).toBe(THREADS_WORKSPACE_ROOT);
  });

  it("falls back to the thread list when nothing was open", () => {
    expect(resolveThreadsHref("/memory")).toBe(THREADS_WORKSPACE_ROOT);
  });
});
