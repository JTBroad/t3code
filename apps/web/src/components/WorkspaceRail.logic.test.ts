import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  getThreadsReturnPath,
  isAppWorkspacePath,
  isReturnablePath,
  isThreadsWorkspacePath,
  LEGACY_MEMORY_ROUTE,
  rememberThreadsPath,
  resetThreadsReturnPathForTest,
  resolveThreadsHref,
  THREADS_WORKSPACE_ROOT,
} from "./WorkspaceRail.logic";

const THREAD_PATH = "/local/th_9f2c";
const MEMORY_APP_PATH = "/apps/memory";

beforeEach(() => {
  resetThreadsReturnPathForTest();
});

describe("isAppWorkspacePath", () => {
  it("matches an app route and its children", () => {
    expect(isAppWorkspacePath(MEMORY_APP_PATH)).toBe(true);
    expect(isAppWorkspacePath("/apps/memory/notes")).toBe(true);
  });

  // The prefix is checked without consulting the registry, so an app the client
  // does not ship still reads as "inside an app". Treating it as a thread route
  // would flash the wrong shell before the route redirected.
  it("matches an unknown app id", () => {
    expect(isAppWorkspacePath("/apps/not-a-real-app")).toBe(true);
  });

  it("does not match a route that merely starts with the same letters", () => {
    expect(isAppWorkspacePath("/appsomething")).toBe(false);
  });

  it("treats settings and threads as part of the Threads workspace", () => {
    expect(isAppWorkspacePath("/settings/general")).toBe(false);
    expect(isAppWorkspacePath(THREAD_PATH)).toBe(false);
    expect(isThreadsWorkspacePath("/settings/general")).toBe(true);
    expect(isThreadsWorkspacePath(MEMORY_APP_PATH)).toBe(false);
  });

  // The old top-level Memory path only redirects now, so it is not itself an app
  // workspace route -- but it must never be a return target either.
  it("does not treat the legacy memory path as an app workspace", () => {
    expect(isAppWorkspacePath(LEGACY_MEMORY_ROUTE)).toBe(false);
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

  it("never remembers an app route", () => {
    // Otherwise the Threads button would point back into the app.
    rememberThreadsPath(THREAD_PATH);
    rememberThreadsPath(MEMORY_APP_PATH);
    expect(getThreadsReturnPath()).toBe(THREAD_PATH);
  });

  // It redirects into the app workspace, so remembering it would send the
  // Threads button there by a second route.
  it("never remembers the legacy memory path", () => {
    rememberThreadsPath(THREAD_PATH);
    rememberThreadsPath(LEGACY_MEMORY_ROUTE);
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
    expect(isReturnablePath("apps/memory")).toBe(false);
    expect(isReturnablePath("")).toBe(false);
  });
});

describe("resolveThreadsHref", () => {
  it("returns to the remembered thread when leaving an app", () => {
    // The bug this exists for: a static "/" is the new-thread starter, so a
    // round trip through an app workspace silently dropped the open thread.
    rememberThreadsPath(THREAD_PATH);
    expect(resolveThreadsHref(MEMORY_APP_PATH)).toBe(THREAD_PATH);
  });

  it("stays on the thread list while already in Threads", () => {
    rememberThreadsPath(THREAD_PATH);
    expect(resolveThreadsHref(THREAD_PATH)).toBe(THREADS_WORKSPACE_ROOT);
  });

  it("falls back to the thread list when nothing was open", () => {
    expect(resolveThreadsHref(MEMORY_APP_PATH)).toBe(THREADS_WORKSPACE_ROOT);
  });
});
