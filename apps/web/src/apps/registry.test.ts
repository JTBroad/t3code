import { APP_ID_MEMORY, type InstalledApp } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_APPS,
  clientAppHref,
  findClientApp,
  mergeApps,
  resolveEnabledApps,
} from "./registry";

const page = (id: string, name = id): InstalledApp => ({
  id,
  name,
  kind: "page",
  entryUrl: `/app-assets/${id}/index.html`,
});

describe("BUILT_IN_APPS", () => {
  it("ships Memory", () => {
    expect(BUILT_IN_APPS.map((app) => app.id)).toContain(APP_ID_MEMORY);
  });

  // Two entries sharing an id would make findClientApp order-dependent and give
  // the rail two buttons that navigate to the same route.
  it("has no duplicate ids", () => {
    const ids = BUILT_IN_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("mergeApps", () => {
  it("puts built-ins first and user apps after", () => {
    const merged = mergeApps([page("foliage")]);
    expect(merged.map((app) => app.id)).toEqual([APP_ID_MEMORY, "foliage"]);
  });

  // A page app shadowing a built-in is the dangerous direction to resolve a
  // collision in: an installed file must not be able to take over the Memory
  // route by naming itself "memory".
  it("drops a user app that collides with a built-in", () => {
    const merged = mergeApps([page(APP_ID_MEMORY, "Not Memory")]);
    expect(merged.map((app) => app.id)).toEqual([APP_ID_MEMORY]);
    expect(merged[0]?.kind).toBe("builtin");
  });

  it("drops a duplicate among user apps", () => {
    const merged = mergeApps([page("dup", "First"), page("dup", "Second")]);
    expect(merged.filter((app) => app.id === "dup").length).toBe(1);
  });

  it("tolerates a missing list", () => {
    expect(mergeApps(undefined).map((app) => app.id)).toEqual(BUILT_IN_APPS.map((app) => app.id));
  });

  it("carries the entry url and provenance through", () => {
    const installed: InstalledApp = {
      ...page("foliage", "Fall Foliage"),
      icon: "🍁",
      source: { artifactId: "drv_1", threadId: "th_2" },
    };
    const entry = mergeApps([installed]).find((app) => app.id === "foliage");

    expect(entry?.label).toBe("Fall Foliage");
    expect(entry?.emoji).toBe("🍁");
    expect(entry?.installed?.entryUrl).toBe("/app-assets/foliage/index.html");
    expect(entry?.installed?.source?.threadId).toBe("th_2");
  });
});

describe("resolveEnabledApps", () => {
  it("filters built-ins by the enabled list", () => {
    const apps = mergeApps([]);
    expect(resolveEnabledApps([APP_ID_MEMORY], apps).map((app) => app.id)).toEqual([APP_ID_MEMORY]);
    expect(resolveEnabledApps([], apps)).toEqual([]);
  });

  // Settings written before enabledApps existed must not silently remove the
  // Memory workspace from someone already using it.
  it("enables built-ins when the setting is absent", () => {
    expect(resolveEnabledApps(undefined, mergeApps([])).map((app) => app.id)).toContain(
      APP_ID_MEMORY,
    );
  });

  // Installing is the opt-in. An app that did not appear until you also flipped
  // a switch would read as a failed install.
  it("shows a user app without it being listed in enabledApps", () => {
    const apps = mergeApps([page("foliage")]);
    expect(resolveEnabledApps([], apps).map((app) => app.id)).toEqual(["foliage"]);
  });
});

describe("findClientApp", () => {
  it("finds within the given list and rejects everything else", () => {
    const apps = mergeApps([page("foliage")]);
    expect(findClientApp("foliage", apps)?.id).toBe("foliage");
    expect(findClientApp("nope", apps)).toBeNull();
    expect(findClientApp(null, apps)).toBeNull();
  });
});

describe("clientAppHref", () => {
  it("routes under the shared app prefix", () => {
    const memory = findClientApp(APP_ID_MEMORY);
    expect(memory && clientAppHref(memory)).toBe(`/apps/${APP_ID_MEMORY}`);
  });
});
