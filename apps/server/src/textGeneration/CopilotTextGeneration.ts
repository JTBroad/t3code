/**
 * CopilotTextGeneration — TextGeneration implementation for the Copilot
 * driver.
 *
 * Phase 1 stub: every operation fails with a typed `TextGenerationError`
 * so callers fall back gracefully. Phase 6 replaces this with a one-shot
 * `@github/copilot-sdk` session per generation (GrokTextGeneration
 * pattern: shared prompt builders + sanitizers, 180s timeout).
 *
 * @module textGeneration/CopilotTextGeneration
 */
import * as Effect from "effect/Effect";
import type { CopilotSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import type * as TextGeneration from "./TextGeneration.ts";

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const notImplemented = (operation: TextGenerationOp) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Copilot text generation is not implemented yet.",
    }),
  );

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  _copilotSettings: CopilotSettings,
  _environment: NodeJS.ProcessEnv = process.env,
) {
  return {
    generateCommitMessage: () => notImplemented("generateCommitMessage"),
    generatePrContent: () => notImplemented("generatePrContent"),
    generateBranchName: () => notImplemented("generateBranchName"),
    generateThreadTitle: () => notImplemented("generateThreadTitle"),
  } satisfies TextGeneration.TextGeneration["Service"];
});
