/**
 * AppTurnHooksRunner - Runs app turn hooks so the reactor does not have to.
 *
 * The reactor asks for contributions and gets back only the ones that are safe
 * to apply. Every guarantee apps are promised is enforced here, once, rather than
 * at each call site in the reactor:
 *
 * - **Fail-open.** A hook that fails, dies, or times out is dropped with a
 *   warning and the turn proceeds without it. The turn is the user's actual
 *   request; a hook is an enhancement.
 * - **Time-bounded.** {@link APP_HOOK_TIMEOUT_MS} per hook, so a hung app cannot
 *   present as a stuck send.
 * - **Disabled apps contribute nothing.** Read at call time, not at boot, so
 *   switching an app off stops changing prompts immediately.
 * - **Nothing invisible.** A contribution's activity travels with its text, and
 *   the reactor appends it. There is no shape here for text without disclosure.
 *
 * Hooks run sequentially in registry order. Concurrency would be easy and is
 * wrong: contributions are prepended to one message, so the order has to be
 * deterministic, and an app store is not something to hammer in parallel for a
 * saving measured against a provider round trip.
 *
 * @module AppTurnHooksRunner
 */
import { type ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  APP_HOOK_TIMEOUT_MS,
  isApplicableContribution,
  type AppTurnContext,
  type AppTurnContribution,
} from "./AppHooks.ts";
import {
  collectEnabledHooks,
  ServerAppRegistryTag,
  type ServerAppRegistry,
} from "./AppRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** A contribution plus the app it came from, for logging and attribution. */
export interface AppContribution {
  readonly appId: string;
  readonly contribution: AppTurnContribution;
}

export class AppTurnHooksRunner extends Context.Service<
  AppTurnHooksRunner,
  {
    /**
     * Collect contributions for a thread's opening message.
     *
     * Never fails: an empty array means "no app had anything to add", which is
     * indistinguishable from "every hook failed" on purpose. The reactor's
     * behaviour is the same either way, and the failures are logged here.
     */
    readonly beforeFirstUserMessage: (
      context: AppTurnContext,
    ) => Effect.Effect<ReadonlyArray<AppContribution>>;
  }
>()("t3/apps/AppTurnHooksRunner") {}

/**
 * Apply the text of every contribution to a message.
 *
 * Joined with a blank line, in the order collected, above the user's own text.
 * Pure so the composition can be tested without a runtime.
 */
export function applyContributions(
  contributions: ReadonlyArray<AppContribution>,
  messageText: string,
): string {
  const blocks = contributions.map((entry) => entry.contribution.prependText);
  return blocks.length === 0 ? messageText : `${blocks.join("\n\n")}\n\n${messageText}`;
}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const registry = yield* ServerAppRegistryTag;

  /**
   * Settings are read per call rather than cached: this is what makes disabling
   * an app take effect on the next turn instead of the next restart. An
   * unreadable settings file falls back to the schema default (every built-in
   * enabled), matching how the rest of the app treats that failure.
   */
  const readEnabledApps = Effect.orElseSucceed(
    Effect.map(settingsService.getSettings, (settings: ServerSettings) => settings.enabledApps),
    () => undefined,
  );

  return {
    beforeFirstUserMessage: (context: AppTurnContext) =>
      Effect.gen(function* () {
        const enabledApps = yield* readEnabledApps;
        const hooks = collectEnabledHooks({ registry, enabledApps });
        const collected: Array<AppContribution> = [];

        for (const { appId, hooks: appHooks } of hooks) {
          const hook = appHooks.beforeFirstUserMessage;
          if (hook === undefined) {
            continue;
          }

          const contribution = yield* hook(context).pipe(
            Effect.timeoutOption(Duration.millis(APP_HOOK_TIMEOUT_MS)),
            Effect.map((option) => (option._tag === "Some" ? option.value : null)),
            // A hook's failure is the app's problem, not the turn's. Logged at
            // warning rather than swallowed: a hook that never contributes looks
            // exactly like an app that is broken, and only the log distinguishes
            // them.
            Effect.catchCause((cause) =>
              Effect.logWarning("app turn hook did not contribute", {
                appId,
                hook: "beforeFirstUserMessage",
                threadId: context.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );

          if (isApplicableContribution(contribution)) {
            collected.push({ appId, contribution });
          }
        }

        return collected;
      }),
  } satisfies AppTurnHooksRunner["Service"];
});

export const layer = Layer.effect(AppTurnHooksRunner, make);

/** Registry contents for tests that need specific apps. */
export const layerRegistry = (registry: ServerAppRegistry) =>
  Layer.succeed(ServerAppRegistryTag, ServerAppRegistryTag.of(registry));
