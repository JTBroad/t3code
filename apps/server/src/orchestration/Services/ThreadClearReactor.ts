/**
 * ThreadClearReactor - Thread clear cleanup reactor service interface.
 *
 * Owns background workers that react to `thread.cleared` domain events and
 * perform the half of a clear the projector cannot do: tearing down the live
 * provider session, dropping the persisted provider resume cursor, and
 * resetting the thread's checkpoint refs to a fresh turn-0 baseline.
 *
 * @module ThreadClearReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadClearReactorShape - Service API for thread clear cleanup.
 */
export interface ThreadClearReactorShape {
  /**
   * Start reacting to thread.cleared orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadClearReactor - Service tag for thread clear cleanup workers.
 */
export class ThreadClearReactor extends Context.Service<
  ThreadClearReactor,
  ThreadClearReactorShape
>()("t3/orchestration/Services/ThreadClearReactor") {}
