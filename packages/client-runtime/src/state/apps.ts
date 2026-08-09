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
import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const APPS_LIST_STALE_TIME_MS = 60_000;

export function createAppsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:apps:list",
    tag: WS_METHODS.appsList,
    staleTimeMs: APPS_LIST_STALE_TIME_MS,
  });

  /**
   * The stale time is what makes this necessary. Installing writes a directory
   * the server only reads when asked, so without an explicit refresh the rail
   * keeps rendering the pre-install list for up to a minute -- which is exactly
   * the "it didn't work" the generous cache was supposed to be invisible for.
   *
   * `onSettled` rather than `onSuccess`, because a failed install can still have
   * written part of an app directory, and a rail that disagrees with disk is
   * worse than one refresh too many.
   */
  const refreshList = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId: target.environmentId, input: {} }));
    });

  return {
    list,
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
      onSettled: refreshList,
    }),
    uninstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:uninstall",
      tag: WS_METHODS.appsUninstall,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
      onSettled: refreshList,
    }),
  };
}
