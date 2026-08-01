/**
 * MemoryView logic - filtering, sorting, and selection for the Memory
 * workspace, kept out of the component so it can be tested without rendering.
 *
 * @module MemoryView.logic
 */
import type { DriveArtifact, MemoryNoteSummary } from "@t3tools/contracts";

export type MemoryTab = "notes" | "drive";

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
