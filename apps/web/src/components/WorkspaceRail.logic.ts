/**
 * WorkspaceRail logic - which route each workspace button returns you to.
 *
 * The Threads button cannot be a static "/": that is the index route, the
 * new-thread starter. Going to an app workspace and back would silently drop
 * whatever thread was open. So the rail remembers the last route the Threads
 * workspace was on and returns there.
 *
 * This is routing state, not thread state -- no thread, panel, or selection
 * store is read or written, which is what keeps the round trip lossless.
 *
 * Everything here is app-agnostic. It used to name Memory specifically; the
 * behaviour was never Memory-shaped, only the vocabulary was.
 *
 * @module WorkspaceRail.logic
 */
import { isAppWorkspacePath } from "@t3tools/contracts";

export const THREADS_WORKSPACE_ROOT = "/";

/**
 * Legacy Memory route.
 *
 * Kept because it is in users' history and bookmarks; the route redirects to the
 * canonical `/apps/memory`. Not a general mechanism -- Memory is the only app
 * that ever had a top-level path.
 */
export const LEGACY_MEMORY_ROUTE = "/memory";

export { isAppWorkspacePath };

/** Threads owns every route that is not an app workspace, including settings. */
export function isThreadsWorkspacePath(pathname: string): boolean {
  return !isAppWorkspacePath(pathname);
}

/**
 * Routes that must never be remembered as a return target.
 *
 * `/pair` and `/connect` render outside the app shell entirely, so returning to
 * one would drop the user back into an auth screen they have already cleared.
 * The legacy Memory path is excluded too: it only ever redirects, so remembering
 * it would send the Threads button into the app workspace.
 */
export function isReturnablePath(pathname: string): boolean {
  if (isAppWorkspacePath(pathname)) return false;
  if (pathname === LEGACY_MEMORY_ROUTE) return false;
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
  return isAppWorkspacePath(currentPathname) ? getThreadsReturnPath() : THREADS_WORKSPACE_ROOT;
}
