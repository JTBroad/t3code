import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { APP_ASSET_ROUTE_PREFIX, APP_MANIFEST_FILENAME } from "@t3tools/contracts";
import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import { resolveAppPaths } from "./apps/AppPaths.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

/**
 * Serves an installed user app's own files.
 *
 * Everything here follows from one fact: this content is untrusted code from a
 * file on disk, loaded into a page that also renders the user's threads.
 *
 * - **Containment.** The app id is validated and the resolved path must stay
 *   inside that app's directory, so a traversal cannot turn this into an
 *   arbitrary file read of the state directory -- which holds secrets and the
 *   thread database.
 * - **A CSP that allows `https:` and nothing else.** The page may run its own
 *   inline scripts and styles and may load and fetch over `https:`. This is a
 *   deliberate widening from the original "no network at all": generated pages
 *   reach for a CDN and for live data as a matter of course, and a sandbox that
 *   only runs pages nobody generates is not a sandbox, it is a wall. The cost is
 *   real and worth stating plainly -- an installed page can send what it can see
 *   to a host of its choosing, and nothing here records which hosts an app was
 *   meant to touch. A per-app `allowedOrigins` in the manifest, chosen at install
 *   time, is the shape that gets that back.
 * - **`http:` is still refused**, so a page cannot be downgraded to plaintext or
 *   sweep the local network over an unencrypted origin.
 * - **`sandbox` on the response.** Belt and braces with the iframe's own
 *   `sandbox` attribute. If a future change loses the attribute, the header
 *   still denies same-origin access rather than silently granting it.
 * - **`nosniff` and no caching.** A re-installed app must not serve its previous
 *   version out of cache.
 *
 * `frame-ancestors` is an allow-list rather than `'self'` because the client is
 * routinely not on this origin: the desktop renderer is `t3code://app`, browser
 * dev is the Vite origin, and the hosted web app is app.t3.codes talking to a
 * server somewhere else entirely. `'self'` would have been correct only for the
 * one surface nobody uses, and the frame would silently fail to load on the rest.
 */
const HOSTED_CLIENT_ORIGINS = [new URL(DEFAULT_HOSTED_APP_URL).origin];

/**
 * Scheme sources for the desktop renderer, alongside its full origins.
 *
 * Custom schemes are the fragile case in a CSP source list, and the failure is
 * silent: a source a browser will not parse is dropped, the frame is refused,
 * and the workspace renders blank with nothing on the page to say why. The
 * scheme form is the belt to the origin's braces. Only this app registers these
 * schemes, so the widening is nominal.
 */
const DESKTOP_RENDERER_SCHEMES = ["t3code:", "t3code-dev:"];

/**
 * Origins allowed to frame an installed app.
 *
 * Same inputs as the CORS layer, for the same reason: these are the origins a
 * client of this server actually runs on. A fork serving its own client from
 * somewhere else must add that origin here -- an omission shows up as an app
 * workspace that will not render, not as a security hole.
 */
export function appFrameAncestors(config: {
  readonly devUrl?: URL | undefined;
  readonly devAllowedOrigins: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const origins = new Set<string>([
    "'self'",
    ...DESKTOP_RENDERER_ORIGINS,
    ...DESKTOP_RENDERER_SCHEMES,
    ...HOSTED_CLIENT_ORIGINS,
    ...config.devAllowedOrigins,
  ]);
  if (config.devUrl) {
    origins.add(config.devUrl.origin);
  }
  return [...origins];
}

export const appAssetRouteLayer = HttpRouter.add(
  "GET",
  `${APP_ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = decodeURIComponent(
      url.value.pathname.slice(`${APP_ASSET_ROUTE_PREFIX}/`.length),
    );
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const appId = suffix.slice(0, separatorIndex);
    const relativePath = suffix.slice(separatorIndex + 1);
    const config = yield* ServerConfig.ServerConfig;
    const paths = resolveAppPaths({ stateDir: config.stateDir, appId });
    if (paths === null || relativePath.length === 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const path = yield* Path.Path;
    const root = path.resolve(paths.dataDirectory);
    const filePath = path.resolve(path.join(root, relativePath));
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    // The manifest is the app's own configuration, not content to serve. Reading
    // it back over HTTP would leak the source thread id to the page.
    if (path.basename(filePath) === APP_MANIFEST_FILENAME) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* Effect.orElseSucceed(fileSystem.exists(filePath), () => false);
    if (!exists) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        // `default-src 'none'` then grant back what a real generated page needs:
        // its own inline code, and `https:` for everything it loads or fetches.
        // `http:` is absent from every directive, so the page cannot be
        // downgraded to plaintext or reach a LAN service over one.
        //
        // `blob:` on `script-src`, `worker-src` and `child-src` because mapping
        // and charting libraries build their workers from a blob URL; without it
        // they fail at runtime in a way that reads as the library being broken.
        "Content-Security-Policy": [
          "default-src 'none'",
          "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
          "style-src 'unsafe-inline' https:",
          "img-src data: blob: https:",
          "font-src data: https:",
          "media-src data: blob: https:",
          "connect-src https:",
          "worker-src blob:",
          "child-src blob:",
          "form-action 'none'",
          `frame-ancestors ${appFrameAncestors(config).join(" ")}`,
          "base-uri 'none'",
        ].join("; "),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        // Deliberately without `allow-same-origin`: combined with
        // `allow-scripts` it would let the page remove its own sandbox.
        sandbox: "allow-scripts allow-forms allow-popups",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
