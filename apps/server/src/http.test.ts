import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { appFrameAncestors, isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("app frame ancestors", () => {
  it("allows the desktop renderer and the hosted client", () => {
    const ancestors = appFrameAncestors({ devAllowedOrigins: [] });

    // The surfaces that are never same-origin with this server. Dropping either
    // of these leaves the app workspace blank on that surface.
    expect(ancestors).toContain("t3code://app");
    // The scheme form too: a custom-scheme origin a browser refuses to parse is
    // dropped silently, and the frame just does not render.
    expect(ancestors).toContain("t3code-dev:");
    expect(ancestors).toContain("https://app.t3.codes");
    expect(ancestors).toContain("'self'");
  });

  it("allows the dev origins a dev client is reached from", () => {
    const ancestors = appFrameAncestors({
      devUrl: new URL("http://127.0.0.1:5173/"),
      devAllowedOrigins: ["http://100.65.180.100:5173"],
    });

    expect(ancestors).toContain("http://127.0.0.1:5173");
    expect(ancestors).toContain("http://100.65.180.100:5173");
  });

  it("does not repeat an origin that arrives from two sources", () => {
    const ancestors = appFrameAncestors({
      devUrl: new URL("http://127.0.0.1:5173/"),
      devAllowedOrigins: ["http://127.0.0.1:5173", "t3code://app"],
    });

    expect(new Set(ancestors).size).toBe(ancestors.length);
  });
});
