/**
 * Memory state - atoms for the shared Zettelkasten and drive surfaces.
 *
 * Consolidation is a single-flight command per environment. The server already
 * refuses a concurrent run and answers "already running", but letting the client
 * fire a second request just to be told no is a worse experience than disabling
 * the control while one is in flight.
 *
 * @module state/memory
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Lists change only when consolidation runs, so they can stay cached a while. */
const MEMORY_LIST_STALE_TIME_MS = 30_000;

export function createMemoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    notes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:memory:notes",
      tag: WS_METHODS.memoryListNotes,
      staleTimeMs: MEMORY_LIST_STALE_TIME_MS,
    }),
    note: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:memory:note",
      tag: WS_METHODS.memoryGetNote,
      staleTimeMs: MEMORY_LIST_STALE_TIME_MS,
    }),
    artifacts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:memory:artifacts",
      tag: WS_METHODS.memoryListArtifacts,
      staleTimeMs: MEMORY_LIST_STALE_TIME_MS,
    }),
    artifact: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:memory:artifact",
      tag: WS_METHODS.memoryGetArtifact,
      staleTimeMs: MEMORY_LIST_STALE_TIME_MS,
    }),
    consolidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:memory:consolidate",
      tag: WS_METHODS.memoryConsolidate,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
