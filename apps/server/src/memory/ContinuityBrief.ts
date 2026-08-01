/**
 * ContinuityBrief - The budgeted grounding digest injected at session start.
 *
 * Named `ContinuityBrief`, never "receipt": `RuntimeReceiptBus` already owns
 * that word for async runtime milestones, and mixing them would confuse every
 * future reader.
 *
 * The constraints here *are* the design. A digest that can grow without bound
 * is prompt bloat with extra steps, and one that always fires trains the model
 * to skip it. So:
 *
 *  - every section has its own character cap, and the whole brief has a total
 *  - notes are ranked current-project-first, then by recency, no embeddings
 *  - only whitelisted sources contribute
 *  - nothing meaningful to say means empty output, not an empty header
 *
 * This module only composes the text. Delivery lives in `BriefInjection.ts`,
 * which prepends the brief to a thread's first user message because no single
 * prompt-composition point reaches every provider -- see that module for why,
 * and for the provider-agnostic seam that should eventually replace it.
 *
 * @module ContinuityBrief
 */
import * as Effect from "effect/Effect";

import { listNotes, type NoteIndexRow } from "./NoteStore.ts";

/** Total budget for the assembled brief. */
export const BRIEF_TOTAL_BUDGET = 2_000;

/** Per-section caps, tuned so no single section can crowd out the others. */
export const SECTION_BUDGETS = {
  identity: 600,
  daily: 500,
  brief: 600,
  themes: 300,
} as const;

export type BriefSection = keyof typeof SECTION_BUDGETS;

export interface BriefInput {
  /** Long-lived facts about the user. */
  readonly identity?: string | undefined;
  /** Recent unconsolidated captures. */
  readonly daily?: string | undefined;
  /** Last consolidation summary. */
  readonly brief?: string | undefined;
  /** Curated themes from the index. */
  readonly themes?: string | undefined;
}

const SECTION_TITLES: Record<BriefSection, string> = {
  identity: "About the user",
  daily: "Captured since last consolidation",
  brief: "Last consolidation",
  themes: "Themes",
};

/** Truncate on a word boundary where possible, so a cap never cuts mid-word. */
export function clampToBudget(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) {
    return trimmed;
  }
  const hardCut = trimmed.slice(0, budget);
  const lastSpace = hardCut.lastIndexOf(" ");
  return `${(lastSpace > budget * 0.6 ? hardCut.slice(0, lastSpace) : hardCut).trimEnd()}…`;
}

/**
 * Assemble the brief.
 *
 * Returns empty string when nothing meaningful changed. Callers should treat
 * that as "inject nothing" rather than emitting a header with no content.
 */
export function composeBrief(input: BriefInput): string {
  const sections: Array<string> = [];

  for (const section of ["identity", "daily", "brief", "themes"] as const) {
    const raw = input[section]?.trim();
    if (!raw) {
      continue;
    }
    sections.push(`## ${SECTION_TITLES[section]}\n${clampToBudget(raw, SECTION_BUDGETS[section])}`);
  }

  if (sections.length === 0) {
    return "";
  }

  // Per-section caps sum above the total on purpose: sections are capped
  // individually so one cannot crowd out another, and the total is the
  // backstop when several are near their limit at once.
  return clampToBudget(`# Continuity brief\n\n${sections.join("\n\n")}`, BRIEF_TOTAL_BUDGET);
}

/**
 * How many distinct signals a brief carries.
 *
 * Used to title the thread activity ("Memory brief · 3 signals"). Counts the
 * section headings rather than lines, so a long daily buffer does not read as
 * dozens of separate signals when it is one section.
 */
export function countContinuitySignals(brief: string): number {
  return brief.split("\n").filter((line) => line.startsWith("## ")).length;
}

export interface RankedNote {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly projectSegment: string | null;
}

/**
 * Rank notes for inclusion: current project first, then most recently
 * modified. Recency and relevance, no embeddings.
 */
export function rankNotes(
  rows: ReadonlyArray<NoteIndexRow>,
  projectSegment: string | null,
): ReadonlyArray<RankedNote> {
  return [...rows]
    .sort((left, right) => {
      const leftLocal = projectSegment !== null && left.project_segment === projectSegment ? 0 : 1;
      const rightLocal =
        projectSegment !== null && right.project_segment === projectSegment ? 0 : 1;
      if (leftLocal !== rightLocal) {
        return leftLocal - rightLocal;
      }
      return right.modified_at.localeCompare(left.modified_at);
    })
    .map((row) => ({
      id: row.id,
      title: row.title,
      scope: row.scope,
      projectSegment: row.project_segment,
    }));
}

/** Render ranked notes as the themes section. */
export function formatThemes(notes: ReadonlyArray<RankedNote>): string {
  return notes.map((note) => `- ${note.title}`).join("\n");
}

/**
 * Build the themes section for a project from the note index.
 *
 * Only the index contributes -- arbitrary workspace files, env files, and
 * settings are outside the whitelist by construction, because this reads the
 * note tables and nothing else.
 */
export const buildThemesSection = Effect.fn("memory.buildThemesSection")(function* (input: {
  readonly projectSegment: string | null;
  readonly limit?: number | undefined;
}) {
  const rows = yield* listNotes({
    status: "active",
    ...(input.projectSegment ? { projectSegment: input.projectSegment } : {}),
    limit: input.limit ?? 10,
  });
  return formatThemes(rankNotes(rows, input.projectSegment ?? null));
});
