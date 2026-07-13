/**
 * CopilotTextGeneration — TextGeneration implementation for the Copilot
 * driver.
 *
 * GrokTextGeneration pattern: one short-lived `@github/copilot-sdk`
 * session per generation, shared prompt builders + sanitizers, JSON
 * structured output, 180s timeout. Tool execution is rejected outright —
 * text generation must never touch the workspace.
 *
 * @module textGeneration/CopilotTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotSettings, ModelSelection } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { makeCopilotClientOptions } from "../provider/Layers/CopilotProvider.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const COPILOT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const runCopilotJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: TextGenerationOp;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const output = yield* Effect.tryPromise(async () => {
        const client = new CopilotClient({
          ...makeCopilotClientOptions(copilotSettings, environment),
          workingDirectory: cwd,
        });
        try {
          await client.start();
          const session = await client.createSession({
            model: modelSelection.model,
            // Keep generations deterministic: no repo instructions/skills.
            skipCustomInstructions: true,
            // Text generation must not run tools or touch the workspace.
            onPermissionRequest: () => ({
              kind: "reject" as const,
              feedback: "Tool execution is not permitted during text generation.",
            }),
          });
          try {
            const finalMessage = await session.sendAndWait({ prompt }, COPILOT_TIMEOUT_MS);
            const content = finalMessage?.data?.content;
            return typeof content === "string" ? content : "";
          } finally {
            await session.disconnect().catch(() => undefined);
          }
        } finally {
          await client.stop().catch(() => client.forceStop().catch(() => undefined));
        }
      }).pipe(
        Effect.timeoutOption(COPILOT_TIMEOUT_MS),
        Effect.flatMap((option) =>
          option._tag === "None"
            ? Effect.fail(
                new TextGenerationError({ operation, detail: "Copilot request timed out." }),
              )
            : Effect.succeed(option.value),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Copilot request failed.",
                cause,
              }),
        ),
      );

      const trimmed = output.trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "Copilot returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Copilot returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CopilotTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runCopilotJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CopilotTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runCopilotJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CopilotTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCopilotJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CopilotTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCopilotJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
