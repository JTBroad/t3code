/**
 * useApps - The merged, enabled app list for this environment.
 *
 * One hook so the rail and the app route cannot disagree about which apps exist.
 * They asked the same question in two places before user apps existed, which was
 * survivable when the answer was a constant and is not now that it comes over
 * the wire.
 *
 * A failed or pending list falls back to built-ins rather than an empty rail:
 * losing the Memory button while a query is in flight would read as the app
 * breaking, and built-ins are known to this build regardless of what the server
 * says.
 *
 * @module apps/useApps
 */
import type { InstalledApp } from "@t3tools/contracts";
import { useMemo } from "react";

import { mergeApps, resolveEnabledApps, type ClientAppEntry } from "./registry";
import { useEnvironmentQuery } from "../state/query";
import { usePrimaryEnvironmentId } from "../state/environments";
import { usePrimarySettings } from "../hooks/useSettings";
import { appsEnvironment } from "../state/apps";

function useInstalledApps(): ReadonlyArray<InstalledApp> {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : appsEnvironment.list({ environmentId, input: {} }),
  );
  return query.data?.apps ?? [];
}

/** Every app this environment shows, in rail order. */
export function useEnabledApps(): ReadonlyArray<ClientAppEntry> {
  const installed = useInstalledApps();
  const enabledApps = usePrimarySettings((settings) => settings.enabledApps);

  return useMemo(
    () => resolveEnabledApps(enabledApps, mergeApps(installed)),
    [enabledApps, installed],
  );
}

/** Look up one app by id within the enabled set. */
export function useApp(appId: string | null): ClientAppEntry | null {
  const apps = useEnabledApps();
  return useMemo(
    () => (appId === null ? null : (apps.find((app) => app.id === appId) ?? null)),
    [appId, apps],
  );
}
