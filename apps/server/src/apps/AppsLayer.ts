/**
 * AppsLayer - The sidebar-app subsystem as one layer.
 *
 * Composed here rather than at each call site because the internal wiring order
 * matters and getting it wrong fails at the type level in a way that reads as a
 * missing service rather than a misordering. The runtime, the reactor tests, and
 * the orchestration harness all want the same three things provided together, so
 * they all take this.
 *
 * Requires only what core already has on hand -- SQL, config, settings, and the
 * platform services -- and provides the host, the registry, and the hook runner.
 *
 * @module AppsLayer
 */
import * as Layer from "effect/Layer";

import * as AppHostLive from "./AppHostLive.ts";
import * as AppRegistryLive from "./AppRegistryLive.ts";
import * as AppTurnHooksRunner from "./AppTurnHooksRunner.ts";
import * as MemoryIndex from "../memory/MemoryIndex.ts";
import * as MemoryDb from "../memory/MemoryDb.ts";

/**
 * `provideMerge` throughout, not `provide`: the host and the registry are both
 * wanted in the output as well as by the runner. The reactor needs the runner,
 * and memory's own modules need the host directly.
 */
export const layer = AppTurnHooksRunner.layer.pipe(
  Layer.provideMerge(AppRegistryLive.layer),
  Layer.provideMerge(AppHostLive.layer),
  // Memory's index: one reindex lock shared by the watcher, note writes, and
  // consolidation, plus the startup pass that catches edits made while the
  // server was down. Merged in here rather than at the runtime because
  // consolidation needs the service and the reactor's brief needs consolidation's
  // output.
  Layer.provideMerge(MemoryIndex.startupLayer),
  // The memory app's own SQLite file and migration sequence. Provided last so
  // everything above it draws on the app store rather than core's database --
  // which is exactly the separation this layer exists to make true.
  Layer.provideMerge(MemoryDb.layer),
);
