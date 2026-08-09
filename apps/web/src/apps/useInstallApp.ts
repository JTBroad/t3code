/**
 * useInstallApp - Installing user apps from the client.
 *
 * The RPC returns a result rather than throwing, so failure is a value to read
 * and surface in the dialog. Installing is the one place a user decides to run
 * someone else's page, and "it silently didn't work" is the worst outcome there:
 * they will assume it worked and go looking for a button that never appears.
 *
 * @module apps/useInstallApp
 */
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { appsEnvironment } from "../state/apps";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

export function useInstallApp() {
  const environmentId = usePrimaryEnvironmentId();
  const [isInstalling, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runInstall = useAtomCommand(appsEnvironment.installFromArtifact, {
    reportFailure: false,
  });

  const install = useCallback(
    async (input: { readonly artifactId: string; readonly name: string }) => {
      if (environmentId === null || isInstalling) {
        return false;
      }

      setInstalling(true);
      setError(null);
      try {
        const result = await runInstall({ environmentId, input });
        if (AsyncResult.isSuccess(result)) {
          return true;
        }
        // The server's message names the actual reason -- a name that cannot be
        // an app id, a missing file, a non-HTML artifact -- and each of those is
        // something the user can act on.
        setError("The app could not be installed. Check the name and try again.");
        return false;
      } finally {
        setInstalling(false);
      }
    },
    [environmentId, isInstalling, runInstall],
  );

  return { install, isInstalling, error };
}
