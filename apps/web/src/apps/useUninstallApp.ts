/**
 * useUninstallApp - Removing a user app from the sidebar.
 *
 * The mirror of {@link useInstallApp}, and it exists for the same reason
 * installing is a user action rather than a tool call: a rail entry a person
 * added is one they must be able to take away, without editing a directory
 * under the state dir by hand.
 *
 * Only page apps can be removed. Built-ins are part of the build and are
 * switched off through `enabledApps` instead -- "uninstall Memory" would have to
 * mean deleting its store, which is not what removing a button should do.
 *
 * @module apps/useUninstallApp
 */
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { appsEnvironment } from "../state/apps";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

export function useUninstallApp() {
  const environmentId = usePrimaryEnvironmentId();
  const [isUninstalling, setUninstalling] = useState(false);
  const runUninstall = useAtomCommand(appsEnvironment.uninstall, { reportFailure: false });

  const uninstall = useCallback(
    async (appId: string) => {
      if (environmentId === null || isUninstalling) {
        return false;
      }

      setUninstalling(true);
      try {
        const result = await runUninstall({ environmentId, input: { appId } });
        return AsyncResult.isSuccess(result) && result.value.removed;
      } finally {
        setUninstalling(false);
      }
    },
    [environmentId, isUninstalling, runUninstall],
  );

  return { uninstall, isUninstalling };
}
