/**
 * MemoryApp - Memory's declaration as a sidebar app.
 *
 * The single place that says what the memory app contributes to the server. The
 * reactor no longer imports anything from `memory/`; it collects hooks from the
 * registry, and this is memory's entry in it.
 *
 * @module MemoryApp
 */
import { APP_ID_MEMORY } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { AppTurnContext, AppTurnContribution } from "../apps/AppHooks.ts";
import { buildBriefForThreadOrEmpty, formatBriefBlock } from "./BriefInjection.ts";
import { countContinuitySignals } from "./ContinuityBrief.ts";

/**
 * Memory's turn participation: a continuity brief on a thread's opening message.
 *
 * The contribution carries its own activity, which is what makes the injection
 * impossible to hide. `payload.brief` is the exact injected text rather than a
 * summary of it -- a summary would not settle "why did it say that?", which is
 * the only question this activity exists to answer.
 *
 * Failures are already absorbed by `buildBriefForThreadOrEmpty`, which degrades
 * to an empty brief. The reactor's fail-open handling is the outer net for
 * anything that gets past it.
 *
 * Still carries its service requirements -- the registry closes over them when it
 * builds, which is what lets the hook type stay free of app-specific context.
 */
export const memoryBeforeFirstUserMessage = (context: AppTurnContext) =>
  Effect.gen(function* () {
    const brief = yield* buildBriefForThreadOrEmpty({ threadId: context.threadId });
    const block = formatBriefBlock(brief);
    if (block.length === 0) {
      return null;
    }

    return {
      prependText: block,
      activity: {
        kind: "memory.continuity-brief.injected",
        tone: "info" as const,
        summary: `Memory brief · ${countContinuitySignals(brief)} signals`,
        payload: { brief },
      },
    } satisfies AppTurnContribution;
  });

export const MEMORY_APP_ID = APP_ID_MEMORY;
