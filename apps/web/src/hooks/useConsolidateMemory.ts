/**
 * Shared entry point for triggering a consolidation run.
 *
 * Both the command palette and the Memory workspace button go through here so
 * they share one in-flight state. Two controls with independent "running" flags
 * would let one of them look idle while a run is under way.
 *
 * @module useConsolidateMemory
 */
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useCallback, useState } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { memoryEnvironment } from "../state/memory";
import { useAtomCommand } from "../state/use-atom-command";

import {
  describeConsolidationOutcome,
  type ConsolidationToast,
} from "../components/CommandPalette.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export interface UseConsolidateMemory {
  readonly consolidate: () => Promise<void>;
  readonly isRunning: boolean;
  readonly canConsolidate: boolean;
}

function showToast(toast: ConsolidationToast): void {
  toastManager.add(
    stackedThreadToast({
      // "Already running" and "nothing to do" are ordinary outcomes, so they
      // must not render as errors -- an error toast for a normal result trains
      // people to distrust the feature.
      type: toast.variant === "error" ? "error" : "info",
      title: "Consolidate memory",
      description: toast.message,
    }),
  );
}

export function useConsolidateMemory(): UseConsolidateMemory {
  const environmentId = usePrimaryEnvironmentId();
  const [isRunning, setIsRunning] = useState(false);
  const runConsolidate = useAtomCommand(memoryEnvironment.consolidate, {
    reportFailure: false,
  });

  const consolidate = useCallback(async () => {
    if (!environmentId || isRunning) {
      return;
    }
    setIsRunning(true);
    try {
      const result = await runConsolidate({ environmentId, input: {} });
      if (AsyncResult.isSuccess(result)) {
        showToast(describeConsolidationOutcome(result.value));
        return;
      }
      showToast({ variant: "error", message: "Consolidation failed. See logs for details." });
    } finally {
      setIsRunning(false);
    }
  }, [environmentId, isRunning, runConsolidate]);

  return { consolidate, isRunning, canConsolidate: environmentId !== null && !isRunning };
}
