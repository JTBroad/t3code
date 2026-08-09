import { APP_ID_MEMORY } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AppTurnHooks } from "./AppHooks.ts";
import { collectEnabledHooks, resolveEnabledApps, type ServerAppRegistry } from "./AppRegistry.ts";

const noopHooks: AppTurnHooks = {
  beforeFirstUserMessage: () => Effect.succeed(null),
};

const registry: ServerAppRegistry = {
  apps: [
    { id: APP_ID_MEMORY, hooks: noopHooks },
    { id: "schedule", hooks: noopHooks },
    { id: "no-hooks" },
  ],
};

describe("resolveEnabledApps", () => {
  it("keeps only the apps that are switched on", () => {
    const enabled = resolveEnabledApps({ registry, enabledApps: [APP_ID_MEMORY] });
    expect(enabled.map((app) => app.id)).toEqual([APP_ID_MEMORY]);
  });

  // Registry order, not enabledApps order, so the rail does not reshuffle when a
  // user toggles one off and on again.
  it("returns registry order regardless of the enabled list's order", () => {
    const enabled = resolveEnabledApps({
      registry,
      enabledApps: ["schedule", APP_ID_MEMORY],
    });
    expect(enabled.map((app) => app.id)).toEqual([APP_ID_MEMORY, "schedule"]);
  });

  // A settings file naming an app this build does not ship must not be able to
  // stop the server from booting.
  it("ignores an unknown app id", () => {
    const enabled = resolveEnabledApps({
      registry,
      enabledApps: [APP_ID_MEMORY, "from-a-newer-build"],
    });
    expect(enabled.map((app) => app.id)).toEqual([APP_ID_MEMORY]);
  });

  it("enables every built-in when settings predate the field", () => {
    const enabled = resolveEnabledApps({ registry, enabledApps: undefined });
    expect(enabled.map((app) => app.id)).toContain(APP_ID_MEMORY);
  });

  it("enables nothing for an explicitly empty list", () => {
    expect(resolveEnabledApps({ registry, enabledApps: [] })).toEqual([]);
  });
});

describe("collectEnabledHooks", () => {
  it("collects hooks only from enabled apps", () => {
    const collected = collectEnabledHooks({ registry, enabledApps: [APP_ID_MEMORY] });
    expect(collected.map((entry) => entry.appId)).toEqual([APP_ID_MEMORY]);
  });

  // A disabled app contributing a turn hook would keep changing prompts after
  // the user switched it off, which is the failure this whole gate exists for.
  it("collects nothing when every app is disabled", () => {
    expect(collectEnabledHooks({ registry, enabledApps: [] })).toEqual([]);
  });

  it("skips an enabled app that declares no hooks", () => {
    const collected = collectEnabledHooks({ registry, enabledApps: ["no-hooks"] });
    expect(collected).toEqual([]);
  });
});
