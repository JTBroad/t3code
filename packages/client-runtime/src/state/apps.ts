/**
 * Apps state - atoms for the installed user-app list.
 *
 * The list is short and changes only when someone installs or removes an app, so
 * it is cached generously. What it must not do is go stale after an install: the
 * rail is driven from this, and an app that does not appear until a reload reads
 * as a failed install.
 *
 * @module state/apps
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const APPS_LIST_STALE_TIME_MS = 60_000;

export function createAppsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:apps:list",
      tag: WS_METHODS.appsList,
      staleTimeMs: APPS_LIST_STALE_TIME_MS,
    }),
    /**
     * Single-flight per environment: installing twice concurrently would have
     * two writers racing over one app directory, and the loser's files would be
     * a half-overwritten mix of both.
     */
    installFromArtifact: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:install",
      tag: WS_METHODS.appsInstallFromArtifact,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    uninstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:uninstall",
      tag: WS_METHODS.appsUninstall,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
