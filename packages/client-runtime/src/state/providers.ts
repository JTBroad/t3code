import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createProvidersEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /**
     * Custom agents discovered for a provider instance (optionally scoped to
     * a workspace cwd). Discovery can spawn a provider CLI server-side, so
     * results are considered fresh for a while before re-fetching.
     */
    listAgents: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:providers:listAgents",
      tag: WS_METHODS.providersListAgents,
      staleTimeMs: 30_000,
    }),
  };
}
