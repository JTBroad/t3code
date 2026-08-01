/**
 * MemoryView logic - filtering, sorting, and selection for the Memory
 * workspace, kept out of the component so it can be tested without rendering.
 *
 * @module MemoryView.logic
 */
import type { DriveArtifact, MemoryDailyEntry, MemoryNoteSummary } from "@t3tools/contracts";

export type MemoryTab = "daily" | "notes" | "drive";

/**
 * Tabs follow the pipeline: captured, then promoted, then produced.
 *
 * Reading left to right is the lifecycle of an observation, which is the only
 * ordering that explains why the three sit together.
 */
export const MEMORY_TABS: ReadonlyArray<{ readonly id: MemoryTab; readonly label: string }> = [
  { id: "daily", label: "Daily" },
  { id: "notes", label: "Notes" },
  { id: "drive", label: "Drive" },
];

/**
 * Notes, not Daily, is where the workspace opens.
 *
 * Daily is empty immediately after every consolidation, so opening there would
 * routinely greet you with nothing; Notes is the content that accumulates.
 */
export const DEFAULT_MEMORY_TAB: MemoryTab = "notes";

export interface NoteFilters {
  readonly scope: string | null;
  readonly status: string | null;
  readonly tag: string | null;
  readonly search: string;
}

export const EMPTY_NOTE_FILTERS: NoteFilters = {
  scope: null,
  status: null,
  tag: null,
  search: "",
};

export function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Filter notes client-side.
 *
 * Scope, status and tag are also server-side filters; applying them again here
 * keeps the list responsive while a refetch is in flight instead of showing
 * stale rows that contradict the controls.
 */
export function filterNotes(
  notes: ReadonlyArray<MemoryNoteSummary>,
  filters: NoteFilters,
): ReadonlyArray<MemoryNoteSummary> {
  const search = normalizeSearch(filters.search);
  return notes.filter((note) => {
    if (filters.scope !== null && note.scope !== filters.scope) return false;
    if (filters.status !== null && note.status !== filters.status) return false;
    if (filters.tag !== null && !note.tags.includes(filters.tag)) return false;
    if (search.length === 0) return true;
    return (
      note.title.toLowerCase().includes(search) ||
      note.tags.some((tag) => tag.toLowerCase().includes(search))
    );
  });
}

/** Every tag present in the corpus, sorted, for the filter control. */
export function collectTags(notes: ReadonlyArray<MemoryNoteSummary>): ReadonlyArray<string> {
  return [...new Set(notes.flatMap((note) => note.tags))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/**
 * Keep a selection valid as the list changes.
 *
 * Returning the first row when the current selection filters out avoids an
 * empty detail pane next to a populated list, which reads as a broken view.
 */
export function resolveSelectedId<T extends { readonly id: string }>(
  rows: ReadonlyArray<T>,
  selectedId: string | null,
): string | null {
  if (rows.length === 0) return null;
  if (selectedId !== null && rows.some((row) => row.id === selectedId)) return selectedId;
  return rows[0]?.id ?? null;
}

export function filterArtifacts(
  artifacts: ReadonlyArray<DriveArtifact>,
  projectSegment: string | null,
): ReadonlyArray<DriveArtifact> {
  if (projectSegment === null) return artifacts;
  return artifacts.filter((artifact) => artifact.projectSegment === projectSegment);
}

export function collectProjectSegments(
  artifacts: ReadonlyArray<DriveArtifact>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      artifacts
        .map((artifact) => artifact.projectSegment)
        .filter((segment): segment is string => segment !== null),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Human-readable size for the drive list. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** Newest first: the last thing captured is the most likely thing being checked. */
export function sortDailyEntries(
  entries: ReadonlyArray<MemoryDailyEntry>,
): ReadonlyArray<MemoryDailyEntry> {
  return [...entries].sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
}

/**
 * Summarise the buffer for the tab label and empty state.
 *
 * `unattributed` is called out separately because an entry with no project is a
 * capture whose thread could not be resolved -- worth noticing rather than
 * silently folding into the total.
 */
export function summarizeDaily(entries: ReadonlyArray<MemoryDailyEntry>): {
  readonly total: number;
  readonly projects: number;
  readonly unattributed: number;
} {
  const projects = new Set(
    entries
      .map((entry) => entry.projectSegment)
      .filter((segment): segment is string => segment !== null),
  );
  return {
    total: entries.length,
    projects: projects.size,
    unattributed: entries.filter((entry) => entry.projectSegment === null).length,
  };
}

/** Redaction markers left by the write-time redactor, e.g. `[redacted:github-token]`. */
const REDACTION_MARKER = /\[redacted:[a-z0-9-]+\]/gi;

export function countRedactions(text: string): number {
  return text.match(REDACTION_MARKER)?.length ?? 0;
}

/**
 * Stable list key for a daily entry.
 *
 * Entries carry no id -- they are lines in a file, not rows. Concurrent appends
 * can share a timestamp, so the body is part of the key rather than relying on
 * `capturedAt` alone.
 */
export function dailyEntryKey(entry: MemoryDailyEntry): string {
  return `${entry.capturedAt}|${entry.threadId ?? ""}|${entry.body}`;
}
