/**
 * AppHooks - How an app participates in a turn.
 *
 * A turn is the user-to-agent cycle the whole product is built around, and it is
 * the one place an app reaches into the harness rather than being reached into.
 * Memory uses this to prepend a continuity brief to a thread's opening message;
 * scheduled prompts will want more of the lifecycle.
 *
 * ## Contributions carry their own disclosure
 *
 * A hook that changes what the model sees returns both the text and the activity
 * describing it, and the reactor appends that activity. The alternative -- apps
 * calling an "append activity" method themselves -- makes disclosure a rule an
 * app can forget. Here the disclosure *is* the contribution: there is no shape
 * for "inject text without saying so".
 *
 * ## Hooks are advisory
 *
 * The turn is the user's actual request; a hook is an enhancement. So the reactor
 * treats every hook as fail-open and time-bounded: a hook that dies or runs long
 * is dropped with a warning and the turn proceeds without it. An app must never
 * be able to wedge a turn, which is also why hooks cannot veto one -- there is no
 * "reject" in the result shape.
 *
 * A hook's error channel is `never`, so absorbing its own expected failures is
 * the app's job: returning `null` is how an app says "I have nothing to add",
 * including when the reason is that something went wrong. The runner still
 * guards against defects and timeouts, because "cannot fail" is a claim about
 * intent and the turn cannot afford to trust it.
 *
 * @module AppHooks
 */
import type * as Effect from "effect/Effect";

import type { AppHostActivity } from "./AppHost.ts";

/** What a hook is told about the turn it is participating in. */
export interface AppTurnContext {
  readonly threadId: string;
  /** ISO timestamp of the triggering event, so activities align with the turn. */
  readonly createdAt: string;
}

/**
 * A hook's contribution to the outgoing message.
 *
 * `prependText` is prepended to the user's message text. `activity` is what the
 * reactor records; it is required whenever `prependText` is non-empty, which the
 * reactor enforces by ignoring a contribution that omits it.
 */
export interface AppTurnContribution {
  readonly prependText: string;
  readonly activity: AppHostActivity;
}

/**
 * Hooks an app may declare. All optional -- an app implements only the points it
 * cares about, and a hook that returns `null` contributes nothing.
 */
export interface AppTurnHooks {
  /**
   * Runs before the first user message of a thread is sent to a provider.
   *
   * The opening turn only, deliberately: context that grounds a fresh session is
   * exactly what a model learns to ignore when it arrives on every turn.
   */
  readonly beforeFirstUserMessage?:
    | ((context: AppTurnContext) => Effect.Effect<AppTurnContribution | null, never, never>)
    | undefined;
}

/**
 * How long a single hook may run before the reactor gives up on it.
 *
 * Short enough that a hung app is not perceptible as a stuck send, long enough
 * that reading a few files off disk is not a race. This is a ceiling on
 * misbehaviour, not a budget apps should plan against.
 */
export const APP_HOOK_TIMEOUT_MS = 2_000;

/**
 * Whether a contribution should actually be applied.
 *
 * Whitespace-only text contributes nothing but would still emit an activity
 * claiming it did, so it is dropped here rather than at each call site.
 */
export function isApplicableContribution(
  contribution: AppTurnContribution | null,
): contribution is AppTurnContribution {
  return contribution !== null && contribution.prependText.trim().length > 0;
}
