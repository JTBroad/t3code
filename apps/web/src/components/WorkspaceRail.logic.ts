/**
 * WorkspaceRail logic - which route each workspace button returns you to.
 *
 * The Threads button cannot be a static "/": that is the index route, the
 * new-thread starter. Going to Memory and back would silently drop whatever
 * thread was open. So the rail remembers the last route the Threads workspace
 * was on and returns there.
 *
 * This is routing state, not thread state -- no thread, panel, or selection
 * store is read or written, which is what keeps the round trip lossless.
 *
 * @module WorkspaceRail.logic
 */

export const THREADS_WORKSPACE_ROOT = "/";
export const MEMORY_WORKSPACE_ROOT = "/memory";

/** Threads owns every route that is not Memory, including settings. */
export function isMemoryWorkspacePath(pathname: string): boolean {
  return pathname === MEMORY_WORKSPACE_ROOT || pathname.startsWith(`${MEMORY_WORKSPACE_ROOT}/`);
}

/**
 * Routes that must never be remembered as a return target.
 *
 * `/pair` and `/connect` render outside the app shell entirely, so returning to
 * one would drop the user back into an auth screen they have already cleared.
 */
export function isReturnablePath(pathname: string): boolean {
  if (isMemoryWorkspacePath(pathname)) return false;
  if (pathname === "/pair") return false;
  if (pathname === "/connect" || pathname.startsWith("/connect/")) return false;
  return pathname.startsWith("/");
}

/**
 * Module-scoped rather than React state on purpose.
 *
 * The rail unmounts on the routes excluded above, and a value that resets when
 * it remounts would lose exactly the thread this exists to preserve.
 */
let rememberedThreadsPath: string = THREADS_WORKSPACE_ROOT;

export function rememberThreadsPath(pathname: string): void {
  if (isReturnablePath(pathname)) {
    rememberedThreadsPath = pathname;
  }
}

export function getThreadsReturnPath(): string {
  return rememberedThreadsPath;
}

/** Test seam: module state would otherwise leak between cases. */
export function resetThreadsReturnPathForTest(): void {
  rememberedThreadsPath = THREADS_WORKSPACE_ROOT;
}

/**
 * Where the Threads button should point right now.
 *
 * While already in Threads it stays "/" so the button still works as "go to the
 * thread list", matching what clicking the active workspace does elsewhere.
 */
export function resolveThreadsHref(currentPathname: string): string {
  return isMemoryWorkspacePath(currentPathname) ? getThreadsReturnPath() : THREADS_WORKSPACE_ROOT;
}
