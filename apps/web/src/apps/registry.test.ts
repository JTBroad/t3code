import { APP_ID_MEMORY } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CLIENT_APPS, clientAppHref, findClientApp, resolveEnabledApps } from "./registry";

describe("CLIENT_APPS", () => {
  it("ships Memory", () => {
    expect(CLIENT_APPS.map((app) => app.id)).toContain(APP_ID_MEMORY);
  });

  // Two entries sharing an id would make findClientApp order-dependent and give
  // the rail two buttons that navigate to the same route.
  it("has no duplicate ids", () => {
    const ids = CLIENT_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveEnabledApps", () => {
  it("keeps only enabled apps", () => {
    expect(resolveEnabledApps([APP_ID_MEMORY]).map((app) => app.id)).toEqual([APP_ID_MEMORY]);
    expect(resolveEnabledApps([])).toEqual([]);
  });

  // Settings written before enabledApps existed must not silently remove the
  // Memory workspace from someone already using it.
  it("enables built-ins when the setting is absent", () => {
    expect(resolveEnabledApps(undefined).map((app) => app.id)).toContain(APP_ID_MEMORY);
  });

  // A newer environment may know about an app this client build cannot render.
  // A rail button that renders nothing is worse than a missing one.
  it("skips an enabled id with no client entry", () => {
    expect(resolveEnabledApps(["not-in-this-build"])).toEqual([]);
  });
});

describe("findClientApp", () => {
  it("finds a known app and rejects everything else", () => {
    expect(findClientApp(APP_ID_MEMORY)?.id).toBe(APP_ID_MEMORY);
    expect(findClientApp("nope")).toBeNull();
    expect(findClientApp(null)).toBeNull();
  });
});

describe("clientAppHref", () => {
  it("routes under the shared app prefix", () => {
    const memory = findClientApp(APP_ID_MEMORY);
    expect(memory && clientAppHref(memory)).toBe(`/apps/${APP_ID_MEMORY}`);
  });
});
