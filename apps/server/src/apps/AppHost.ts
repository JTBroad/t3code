/**
 * AppHost - The only surface a sidebar app may use to reach core.
 *
 * Apps (memory today, schedule next, user-authored pages later) are not allowed
 * to import from the rest of `apps/server/src`. They ask for `AppHost` and get
 * exactly the core state and core effects they are entitled to. That inversion
 * is the whole point: an app's dependency list becomes a thing you can read off
 * its imports rather than something you discover by grepping for tables.
 *
 * ## Every method here must stay serializable
 *
 * Built-in apps call these directly, in process. User-authored apps will
 * eventually call the same methods over `postMessage` from a sandboxed iframe,
 * with this interface as the bridge's wire shape. So:
 *
 * - arguments and results are plain data -- no functions, no callbacks, no class
 *   instances, no `SqlClient` or other handles
 * - every method is an Effect, never a synchronous accessor, because the bridged
 *   form is always asynchronous
 * - failures are typed as {@link AppHostError}, which carries a string reason
 *   rather than a wrapped cause, because a cause does not cross a bridge
 *
 * A method that cannot survive those constraints does not belong here. The
 * temptation is to hand out `SqlClient` and be done; that would make the iframe
 * transport impossible to add later without redesigning against two consumers.
 *
 * ## Keep this list short
 *
 * Every method is a compatibility obligation, and once user apps exist it is
 * frozen against files on users' disks. {@link APP_HOST_API_VERSION} is what
 * lets a manifest say which shape it was written against.
 *
 * @module AppHost
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * Version of the host API surface.
 *
 * Bumped when a method is removed or its shape changes incompatibly; additive
 * methods do not bump it. A user app's manifest declares the version it targets
 * so the host can refuse to load a page written against a shape it no longer
 * serves. Nothing depends on this yet -- it exists now precisely so that the
 * first thing which does is not also the thing that has to introduce it.
 */
export const APP_HOST_API_VERSION = 1;

/**
 * The one failure shape host methods produce.
 *
 * Deliberately a flat string reason rather than a wrapped `Cause`: an app on the
 * far side of a postMessage bridge cannot receive a Cause, and an app that could
 * receive one would start matching on core's internal error types.
 */
export class AppHostError extends Data.TaggedError("AppHostError")<{
  readonly operation: string;
  readonly reason: string;
}> {}

/**
 * A project as an app sees it.
 *
 * `repositoryPath` is the workspace root, deliberately not a worktree path -- a
 * worktree is per-thread and per-branch, so keying app data on it would split
 * one repository's data across every branch ever worked on.
 */
export interface AppHostProject {
  readonly repositoryPath: string;
  readonly projectSegment: string;
}

/** Where an app's own state lives. Absolute paths, owned by that app alone. */
export interface AppHostPaths {
  /** Directory for this app's data. Nothing outside the app writes here. */
  readonly dataDirectory: string;
  /** This app's SQLite index file, inside {@link dataDirectory}. */
  readonly databasePath: string;
}

/**
 * An entry an app contributes to a thread's timeline.
 *
 * `kind` is namespaced by the app (`memory.continuity-brief.injected`). `payload`
 * is plain JSON so it survives both the event log and the bridge.
 *
 * There is deliberately no `appendThreadActivity` method on {@link AppHost} that
 * takes one of these. Apps return activities from their turn hooks and the
 * reactor appends them on the app's behalf -- see `AppHooks`. That direction is
 * what makes the "nothing an app injects is invisible" invariant structural: an
 * app cannot contribute to a prompt and forget to declare it, because the
 * declaration is the same value as the contribution. Handing apps a direct
 * append would also make `AppHost` depend on the orchestration engine, which
 * depends on the reactor, which depends on the app registry -- a layer cycle
 * bought for a method nothing needs.
 */
export interface AppHostActivity {
  readonly kind: string;
  readonly summary: string;
  readonly tone: "info" | "warning" | "error";
  readonly payload: Record<string, unknown>;
}

export class AppHost extends Context.Service<
  AppHost,
  {
    /** The host API shape this implementation serves. */
    readonly apiVersion: number;

    /**
     * Resolve a thread to the project it belongs to.
     *
     * Succeeds with `null` rather than failing when the thread, its project, or
     * a usable segment is missing: an app that cannot attribute work should
     * record it as unattributed, not abort.
     */
    readonly resolveProjectForThread: (
      threadId: string,
    ) => Effect.Effect<AppHostProject | null, AppHostError>;

    /** Resolve this app's own storage locations. */
    readonly paths: (appId: string) => Effect.Effect<AppHostPaths, AppHostError>;
  }
>()("t3/apps/AppHost") {}
