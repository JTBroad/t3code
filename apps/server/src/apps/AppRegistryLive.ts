/**
 * AppRegistryLive - The apps this server ships.
 *
 * One entry per built-in. Adding an app is an entry here plus its own module;
 * nothing in the reactor, the MCP server, or the shell needs to learn its name.
 *
 * ## Why this is a layer rather than a constant
 *
 * A hook's declared type has no requirements channel (`R = never`), because a
 * registry holding several apps cannot express a union of whatever services each
 * one happens to need. So the requirements are discharged here: the layer
 * captures the runtime context once and provides it to each app's hook. Apps get
 * to write hooks in terms of the services they need, and the reactor stays free
 * of every app's dependencies.
 *
 * MCP toolkit registration is deliberately not listed here. A toolkit's
 * registration layer carries its own handler requirements, and expressing a
 * heterogeneous list of those in one array would mean naming every app's
 * dependencies in the registry type. `McpHttpServer` reads the same `enabledApps`
 * setting to decide what to mount, so the toggle still governs both.
 *
 * @module AppRegistryLive
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AppHost } from "./AppHost.ts";
import { ServerAppRegistryTag, type ServerAppRegistry } from "./AppRegistry.ts";
import { ServerConfig } from "../config.ts";
import { memoryBeforeFirstUserMessage, MEMORY_APP_ID } from "../memory/MemoryApp.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/**
 * Services the built-in apps' hooks draw on.
 *
 * Listed explicitly rather than inferred so adding a dependency to an app is a
 * visible change here -- this is the closest thing to a manifest of what the
 * built-ins can reach.
 */
type BuiltInAppServices =
  | AppHost
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | SqlClient.SqlClient;

const make = Effect.gen(function* () {
  const context = yield* Effect.context<BuiltInAppServices>();

  return {
    apps: [
      {
        id: MEMORY_APP_ID,
        hooks: {
          beforeFirstUserMessage: (turnContext) =>
            memoryBeforeFirstUserMessage(turnContext).pipe(Effect.provide(context)),
        },
      },
    ],
  } satisfies ServerAppRegistry;
});

export const layer = Layer.effect(ServerAppRegistryTag, make);
