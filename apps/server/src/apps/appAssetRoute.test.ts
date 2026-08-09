/**
 * Serves the app-asset route for real and reads the response.
 *
 * The unit tests around it check path resolution in isolation, which is exactly
 * the class of bug they cannot catch: a route that resolves the right file and
 * still hands the browser something it will not render. This drives the actual
 * handler and asserts on the status, the content type, and the prefix the frame
 * is fetched from.
 *
 * `provideRequest` rather than `Layer.provide`, because a route handler's
 * services are resolved per request. Providing them to the layer alone builds
 * fine and then fails inside every handler.
 */
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { APP_ASSET_ROUTE_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { installPageApp } from "./AppInstaller.ts";
import * as ServerConfig from "../config.ts";
import { appAssetRouteLayer } from "../http.ts";

const PAGE = "<!doctype html><title>Foliage</title><h1>hello</h1>";

const install = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped();
  yield* installPageApp({
    stateDir,
    appId: "foliage",
    name: "Fall Foliage",
    contents: PAGE,
    source: { artifactId: "drv_1" },
  });
  return stateDir;
});

const request = Effect.fn(function* (stateDir: string, path: string) {
  const services = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpPlatform.layer,
    Layer.succeed(
      ServerConfig.ServerConfig,
      ServerConfig.make({
        stateDir,
        devAllowedOrigins: [],
      } as unknown as ServerConfig.ServerConfig["Service"]),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpRouter.provideRequest(services)(appAssetRouteLayer),
    { disableLogger: true },
  );
  const response = yield* Effect.promise(() =>
    handler(new Request(`http://127.0.0.1:3773${path}`)),
  );
  const body = yield* Effect.promise(() => response.text());
  yield* Effect.promise(dispose);
  return { response, body };
});

describe("app asset route", () => {
  it.effect("serves the installed page as HTML", () =>
    Effect.gen(function* () {
      const stateDir = yield* install();
      const { response, body } = yield* request(
        stateDir,
        `${APP_ASSET_ROUTE_PREFIX}/foliage/index.html`,
      );

      expect(response.status).toBe(200);
      // An octet-stream here downloads instead of rendering, which inside a
      // frame is indistinguishable from a blank page.
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(body).toBe(PAGE);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows https and refuses http in every fetching directive", () =>
    Effect.gen(function* () {
      const stateDir = yield* install();
      const { response } = yield* request(stateDir, `${APP_ASSET_ROUTE_PREFIX}/foliage/index.html`);
      const csp = response.headers.get("content-security-policy") ?? "";
      const directives = Object.fromEntries(
        csp.split("; ").map((directive) => {
          const [name, ...sources] = directive.split(" ");
          return [name, sources];
        }),
      );

      // A page app may reach the network. This is a deliberate posture, not an
      // oversight, so it is pinned: generated pages load libraries and data from
      // https, and without this they render broken.
      expect(directives["connect-src"]).toContain("https:");
      expect(directives["script-src"]).toContain("https:");
      // Workers built from a blob URL are how mapping libraries start up.
      expect(directives["worker-src"]).toContain("blob:");
      // No plaintext in anything the page fetches: no downgrade, and no
      // sweeping a LAN service. Checked per directive rather than across the
      // whole header, because `frame-ancestors` legitimately names http origins
      // for the dev client.
      for (const name of [
        "script-src",
        "style-src",
        "img-src",
        "font-src",
        "media-src",
        "connect-src",
      ]) {
        expect(directives[name]).not.toContain("http:");
      }
      // Still not a same-origin page, and still cannot post itself somewhere.
      expect(directives["default-src"]).toEqual(["'none'"]);
      expect(directives["form-action"]).toEqual(["'none'"]);
      expect(directives["base-uri"]).toEqual(["'none'"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("is served from a dev-proxied prefix", () => {
    // The frame is loaded from whatever origin the client is on, and in browser
    // dev that is the web dev server, which answers a prefix it does not proxy
    // with the SPA shell -- so the app never loads and the frame renders blank.
    // `/api` is on the proxied list; a top-level prefix is not.
    expect(APP_ASSET_ROUTE_PREFIX.startsWith("/api/")).toBe(true);
  });

  it.effect("refuses a path that escapes the app directory", () =>
    Effect.gen(function* () {
      const stateDir = yield* install();
      const { response } = yield* request(
        stateDir,
        `${APP_ASSET_ROUTE_PREFIX}/foliage/..%2F..%2Fstate.sqlite`,
      );

      expect(response.status).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not serve the manifest", () =>
    Effect.gen(function* () {
      const stateDir = yield* install();
      const { response } = yield* request(
        stateDir,
        `${APP_ASSET_ROUTE_PREFIX}/foliage/manifest.json`,
      );

      expect(response.status).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
