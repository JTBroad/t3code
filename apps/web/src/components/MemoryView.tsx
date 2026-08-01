/**
 * MemoryView - the Memory workspace: notes and drive artifacts.
 *
 * Provenance runs both ways here, which is the point of putting the two tabs in
 * one workspace: a note links to the artifacts it came from, and an artifact
 * lists the notes citing it. That is the "why does the agent believe this?"
 * answer made clickable.
 *
 * Filtering, sorting and selection live in `MemoryView.logic.ts`.
 *
 * @module MemoryView
 */
import { useCallback, useMemo, useState } from "react";

import { useConsolidateMemory } from "../hooks/useConsolidateMemory";
import { useEnvironmentQuery } from "../state/query";
import { usePrimaryEnvironmentId } from "../state/environments";
import { memoryEnvironment } from "../state/memory";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  collectProjectSegments,
  collectTags,
  countRedactions,
  dailyEntryKey,
  DEFAULT_MEMORY_TAB,
  EMPTY_NOTE_FILTERS,
  MEMORY_TABS,
  sortDailyEntries,
  summarizeDaily,
  filterArtifacts,
  filterNotes,
  formatByteSize,
  resolveSelectedId,
  type MemoryTab,
  type NoteFilters,
} from "./MemoryView.logic";

function EmptyState({ message }: { readonly message: string }) {
  return <p className="p-4 text-sm text-muted-foreground">{message}</p>;
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly options: ReadonlyArray<string>;
  readonly onChange: (next: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function MemoryView() {
  const environmentId = usePrimaryEnvironmentId();
  const [tab, setTab] = useState<MemoryTab>(DEFAULT_MEMORY_TAB);
  const [noteFilters, setNoteFilters] = useState<NoteFilters>(EMPTY_NOTE_FILTERS);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [projectSegment, setProjectSegment] = useState<string | null>(null);
  const { consolidate, isRunning } = useConsolidateMemory();

  const dailyQuery = useEnvironmentQuery(
    environmentId === null ? null : memoryEnvironment.daily({ environmentId, input: {} }),
  );
  const notesQuery = useEnvironmentQuery(
    environmentId === null ? null : memoryEnvironment.notes({ environmentId, input: {} }),
  );
  const artifactsQuery = useEnvironmentQuery(
    environmentId === null ? null : memoryEnvironment.artifacts({ environmentId, input: {} }),
  );

  const dailyEntries = useMemo(
    () => sortDailyEntries(dailyQuery.data?.entries ?? []),
    [dailyQuery.data?.entries],
  );
  const dailySummary = useMemo(() => summarizeDaily(dailyEntries), [dailyEntries]);
  const notes = notesQuery.data?.notes ?? [];
  const artifacts = artifactsQuery.data?.artifacts ?? [];

  const visibleNotes = useMemo(() => filterNotes(notes, noteFilters), [notes, noteFilters]);
  const visibleArtifacts = useMemo(
    () => filterArtifacts(artifacts, projectSegment),
    [artifacts, projectSegment],
  );
  const tags = useMemo(() => collectTags(notes), [notes]);
  const segments = useMemo(() => collectProjectSegments(artifacts), [artifacts]);

  const activeNoteId = resolveSelectedId(visibleNotes, selectedNoteId);
  const activeArtifactId = resolveSelectedId(visibleArtifacts, selectedArtifactId);

  const noteQuery = useEnvironmentQuery(
    environmentId === null || activeNoteId === null
      ? null
      : memoryEnvironment.note({ environmentId, input: { id: activeNoteId } }),
  );
  const artifactQuery = useEnvironmentQuery(
    environmentId === null || activeArtifactId === null
      ? null
      : memoryEnvironment.artifact({ environmentId, input: { id: activeArtifactId } }),
  );

  const refreshAll = useCallback(async () => {
    await consolidate();
    // Daily first: consolidation clears it, so a stale buffer would still show
    // entries that have already been promoted.
    dailyQuery.refresh();
    notesQuery.refresh();
    artifactsQuery.refresh();
    // The detail panes need refreshing too. A run reindexes every note, so the
    // open one can change underneath a stale cache -- and the note whose
    // content just changed is exactly the one being looked at.
    noteQuery.refresh();
    artifactQuery.refresh();
  }, [artifactQuery, artifactsQuery, consolidate, dailyQuery, noteQuery, notesQuery]);

  /** Jumping to an artifact switches tabs, so the link actually lands somewhere. */
  const openArtifact = useCallback((id: string) => {
    setSelectedArtifactId(id);
    setProjectSegment(null);
    setTab("drive");
  }, []);

  const openNote = useCallback((id: string) => {
    setSelectedNoteId(id);
    setNoteFilters(EMPTY_NOTE_FILTERS);
    setTab("notes");
  }, []);

  const dailyContents = dailyQuery.data?.contents ?? "";
  const redactionCount = useMemo(() => countRedactions(dailyContents), [dailyContents]);
  const note = noteQuery.data?.note ?? null;
  const backlinks = noteQuery.data?.backlinks ?? [];
  const artifact = artifactQuery.data?.artifact ?? null;
  const citingNotes = artifactQuery.data?.citingNotes ?? [];

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border/60">
        <div className="flex items-center gap-1 border-b border-border/60 p-2">
          {MEMORY_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? "page" : undefined}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-sm transition-colors",
                tab === entry.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {entry.label}
              {entry.id === "daily" && dailySummary.total > 0 ? (
                <span className="ml-1 text-xs text-muted-foreground">{dailySummary.total}</span>
              ) : null}
            </button>
          ))}
        </div>

        {tab === "daily" ? (
          <div className="border-b border-border/60 p-2 text-xs text-muted-foreground">
            {dailySummary.total === 0
              ? "Buffer is empty."
              : `${dailySummary.total} awaiting promotion · ${dailySummary.projects} project${dailySummary.projects === 1 ? "" : "s"}`}
            {dailySummary.unattributed > 0 ? (
              // Surfaced rather than folded into the total: an unattributed
              // capture means thread resolution failed, and consolidation will
              // not be able to scope the note it produces.
              <span className="ml-1 text-amber-500">
                · {dailySummary.unattributed} unattributed
              </span>
            ) : null}
          </div>
        ) : tab === "notes" ? (
          <div className="flex flex-col gap-2 border-b border-border/60 p-2">
            <input
              type="search"
              value={noteFilters.search}
              onChange={(event) =>
                setNoteFilters((current) => ({ ...current, search: event.target.value }))
              }
              placeholder="Search notes"
              aria-label="Search notes"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
            <div className="flex gap-2">
              <FilterSelect
                label="Scope"
                value={noteFilters.scope}
                options={["global", "project"]}
                onChange={(scope) => setNoteFilters((current) => ({ ...current, scope }))}
              />
              <FilterSelect
                label="Status"
                value={noteFilters.status}
                options={["active", "demoted", "archived"]}
                onChange={(status) => setNoteFilters((current) => ({ ...current, status }))}
              />
            </div>
            <FilterSelect
              label="Tag"
              value={noteFilters.tag}
              options={tags}
              onChange={(tag) => setNoteFilters((current) => ({ ...current, tag }))}
            />
          </div>
        ) : (
          <div className="border-b border-border/60 p-2">
            <FilterSelect
              label="Project"
              value={projectSegment}
              options={segments}
              onChange={setProjectSegment}
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "daily" ? (
            dailyEntries.length === 0 ? (
              <EmptyState message="Nothing captured since the last consolidation." />
            ) : (
              <ul>
                {dailyEntries.map((entry) => (
                  <li
                    key={dailyEntryKey(entry)}
                    className="border-b border-border/40 px-3 py-2 last:border-b-0"
                  >
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {entry.capturedAt}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {entry.projectSegment ?? "unattributed"}
                      {entry.threadId ? ` · ${entry.threadId}` : ""}
                    </p>
                    {/* Plain text, so a `[redacted:...]` marker reads as
                        something removed rather than as a typo. */}
                    <p className="mt-1 whitespace-pre-wrap text-sm">{entry.body}</p>
                  </li>
                ))}
              </ul>
            )
          ) : tab === "notes" ? (
            visibleNotes.length === 0 ? (
              <EmptyState
                message={
                  notes.length === 0
                    ? "No notes yet. Consolidate to promote captured observations."
                    : "No notes match these filters."
                }
              />
            ) : (
              <ul>
                {visibleNotes.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedNoteId(entry.id)}
                      className={cn(
                        "w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50",
                        entry.id === activeNoteId && "bg-accent text-accent-foreground",
                      )}
                    >
                      <span className="block truncate font-medium">{entry.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.scope}
                        {entry.projectSegment ? ` · ${entry.projectSegment}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : visibleArtifacts.length === 0 ? (
            <EmptyState message="No artifacts yet." />
          ) : (
            <ul>
              {visibleArtifacts.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedArtifactId(entry.id)}
                    className={cn(
                      "w-full px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50",
                      entry.id === activeArtifactId && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="block truncate font-medium">{entry.relativePath}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.kind} · {formatByteSize(entry.byteSize)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border/60 p-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isRunning || environmentId === null}
            onClick={() => void refreshAll()}
          >
            {isRunning ? "Consolidating…" : "Consolidate now"}
          </Button>
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto p-6">
        {tab === "daily" ? (
          dailyEntries.length === 0 ? (
            <EmptyState message="Nothing captured since the last consolidation. Observations land here first, then Consolidate promotes them into notes." />
          ) : (
            <article className="flex max-w-3xl flex-col gap-3">
              <header className="flex flex-col gap-1">
                <h1 className="text-lg font-semibold">Daily capture buffer</h1>
                <p className="text-xs text-muted-foreground">
                  Read-only. Consolidation promotes these into notes and clears the buffer.
                  {redactionCount > 0
                    ? ` ${redactionCount} secret${redactionCount === 1 ? "" : "s"} stripped on write.`
                    : ""}
                </p>
              </header>
              {/* The raw file, so what is on disk is exactly what is shown --
                  including redaction markers and any hand edits. */}
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-relaxed">
                {dailyContents}
              </pre>
            </article>
          )
        ) : tab === "notes" ? (
          note === null ? (
            <EmptyState message="Select a note." />
          ) : (
            <article className="flex max-w-3xl flex-col gap-4">
              <header className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">{note.title}</h1>
                <p className="font-mono text-xs text-muted-foreground">
                  {note.id} · {note.status} · {note.scope}
                  {note.projectSegment ? ` · ${note.projectSegment}` : ""}
                </p>
                {note.tags.length > 0 ? (
                  <p className="text-xs text-muted-foreground">{note.tags.join(", ")}</p>
                ) : null}
              </header>

              {/* Redaction markers must stay legible: a note reading
                  "[redacted:github-token]" should look like something was
                  removed, not like a typo. Plain text preserves them exactly. */}
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{note.body}</div>

              {note.sources.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h2 className="text-xs font-semibold uppercase text-muted-foreground">Sources</h2>
                  <ul className="flex flex-col gap-1">
                    {note.sources.map((source) => (
                      <li key={source.artifactId}>
                        <button
                          type="button"
                          className="text-left text-sm text-primary underline-offset-2 hover:underline"
                          onClick={() => openArtifact(source.artifactId)}
                        >
                          {source.rel}: {source.artifactId}
                        </button>
                        {source.context ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {source.context}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {backlinks.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h2 className="text-xs font-semibold uppercase text-muted-foreground">
                    Backlinks
                  </h2>
                  <ul className="flex flex-col gap-1">
                    {backlinks.map((backlink) => (
                      <li key={backlink.noteId}>
                        <button
                          type="button"
                          className="text-left text-sm text-primary underline-offset-2 hover:underline"
                          onClick={() => openNote(backlink.noteId)}
                        >
                          {backlink.title ?? backlink.noteId}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </article>
          )
        ) : artifact === null ? (
          <EmptyState message="Select an artifact." />
        ) : (
          <article className="flex max-w-3xl flex-col gap-4">
            <header className="flex flex-col gap-1">
              <h1 className="text-lg font-semibold">{artifact.relativePath}</h1>
              <p className="font-mono text-xs text-muted-foreground">
                {artifact.kind} · {formatByteSize(artifact.byteSize)} · {artifact.createdAt}
              </p>
              {artifact.threadId ? (
                <p className="text-xs text-muted-foreground">Thread {artifact.threadId}</p>
              ) : null}
            </header>

            <section className="flex flex-col gap-1">
              <h2 className="text-xs font-semibold uppercase text-muted-foreground">Cited by</h2>
              {citingNotes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No notes cite this artifact.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {citingNotes.map((citing) => (
                    <li key={citing.noteId}>
                      <button
                        type="button"
                        className="text-left text-sm text-primary underline-offset-2 hover:underline"
                        onClick={() => openNote(citing.noteId)}
                      >
                        {citing.title ?? citing.noteId}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </article>
        )}
      </section>
    </div>
  );
}
