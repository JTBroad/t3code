import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { APP_HOOK_TIMEOUT_MS, type AppTurnContribution } from "./AppHooks.ts";
import { ServerAppRegistryTag, type ServerAppRegistry } from "./AppRegistry.ts";
import {
  applyContributions,
  AppTurnHooksRunner,
  layer as runnerLayer,
  type AppContribution,
} from "./AppTurnHooksRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const contribution = (text: string): AppTurnContribution => ({
  prependText: text,
  activity: { kind: "test.contributed", tone: "info", summary: text, payload: { text } },
});

const CONTEXT = { threadId: "th_1", createdAt: "2026-08-07T00:00:00Z" };

const runWith = <A>(
  registry: ServerAppRegistry,
  enabledApps: ReadonlyArray<string> | undefined,
  use: (runner: AppTurnHooksRunner["Service"]) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const runner = yield* AppTurnHooksRunner;
    return yield* use(runner);
  }).pipe(
    Effect.provide(
      runnerLayer.pipe(
        Layer.provide(Layer.succeed(ServerAppRegistryTag, ServerAppRegistryTag.of(registry))),
        Layer.provide(
          ServerSettingsService.layerTest(
            enabledApps === undefined ? {} : { enabledApps: [...enabledApps] },
          ),
        ),
      ),
    ),
  );

const collect = (registry: ServerAppRegistry, enabledApps?: ReadonlyArray<string>) =>
  runWith(registry, enabledApps, (runner) => runner.beforeFirstUserMessage(CONTEXT));

it.effect("collects contributions from enabled apps in registry order", () =>
  Effect.gen(function* () {
    const collected = yield* collect(
      {
        apps: [
          {
            id: "first",
            hooks: { beforeFirstUserMessage: () => Effect.succeed(contribution("A")) },
          },
          {
            id: "second",
            hooks: { beforeFirstUserMessage: () => Effect.succeed(contribution("B")) },
          },
        ],
      },
      ["second", "first"],
    );

    expect(collected.map((entry) => entry.appId)).toEqual(["first", "second"]);
  }),
);

// The turn is the user's request; a hook is an enhancement. A dying app must not
// take the turn with it.
it.effect("drops a hook that dies and keeps the others", () =>
  Effect.gen(function* () {
    const collected = yield* collect(
      {
        apps: [
          { id: "broken", hooks: { beforeFirstUserMessage: () => Effect.die("boom") } },
          {
            id: "fine",
            hooks: { beforeFirstUserMessage: () => Effect.succeed(contribution("B")) },
          },
        ],
      },
      ["broken", "fine"],
    );

    expect(collected.map((entry) => entry.appId)).toEqual(["fine"]);
  }),
);

// A live clock, not the test clock: the point is that wall-clock time is what
// bounds a hung app, and a virtual clock would pass whether or not the timeout
// actually fires.
it.live("drops a hook that outruns the timeout", () =>
  Effect.gen(function* () {
    const collected = yield* collect(
      {
        apps: [
          {
            id: "slow",
            hooks: {
              beforeFirstUserMessage: () =>
                Effect.succeed(contribution("late")).pipe(Effect.delay(APP_HOOK_TIMEOUT_MS * 2)),
            },
          },
          {
            id: "fast",
            hooks: { beforeFirstUserMessage: () => Effect.succeed(contribution("B")) },
          },
        ],
      },
      ["slow", "fast"],
    );

    expect(collected.map((entry) => entry.appId)).toEqual(["fast"]);
  }),
);

// The whole point of the enabled gate: a disabled app must stop changing prompts
// immediately, not at the next restart.
it.effect("collects nothing from a disabled app", () =>
  Effect.gen(function* () {
    const collected = yield* collect(
      {
        apps: [
          { id: "off", hooks: { beforeFirstUserMessage: () => Effect.succeed(contribution("A")) } },
        ],
      },
      [],
    );

    expect(collected).toEqual([]);
  }),
);

it.effect("ignores a hook that returns nothing or only whitespace", () =>
  Effect.gen(function* () {
    const collected = yield* collect(
      {
        apps: [
          { id: "null", hooks: { beforeFirstUserMessage: () => Effect.succeed(null) } },
          {
            id: "blank",
            hooks: { beforeFirstUserMessage: () => Effect.succeed(contribution("   \n ")) },
          },
        ],
      },
      ["null", "blank"],
    );

    expect(collected).toEqual([]);
  }),
);

it("prepends contributions above the user's text, joined by a blank line", () => {
  const contributions: ReadonlyArray<AppContribution> = [
    { appId: "one", contribution: contribution("FIRST") },
    { appId: "two", contribution: contribution("SECOND") },
  ];
  expect(applyContributions(contributions, "hello")).toBe("FIRST\n\nSECOND\n\nhello");
});

// "Nothing meaningful changed" must cost the turn nothing at all -- not even a
// leading newline, which would show up in the transcript.
it("leaves the message untouched when nothing contributed", () => {
  expect(applyContributions([], "hello")).toBe("hello");
});
