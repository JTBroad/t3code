/**
 * NoteStore - Permanent Zettelkasten notes: markdown files plus a SQL index.
 *
 * The markdown file is the source of truth. Notes stay hand-editable and
 * greppable on purpose, so the index must be reconstructible from them at any
 * time -- that is what {@link reindexAll} is for, and why consolidation runs it
 * first. A row without a file is a dangling reference; a file without a row is
 * repaired on the next reindex, so writes go file-first.
 *
 * Two details carry most of the long-term value and should survive
 * refactoring: links record a `rel` and a `context` sentence (a link that
 * explains itself is still useful a year later, a bare backlink is not), and
 * `backlinksFor` is an indexed lookup rather than a corpus scan.
 *
 * @module NoteStore
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { isReservedMemoryFile } from "./DailyStore.ts";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Tags round-trip through the index as a JSON array so `json_each` can filter them. */
const TagsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeTags = Schema.encodeSync(TagsJson);

export type NoteStatus = "active" | "demoted" | "archived";
export type NoteScope = "global" | "project";

export interface NoteLink {
  readonly id: string;
  readonly rel: string;
  /** Why the link exists. Without it a backlink is unreadable later. */
  readonly context?: string | undefined;
}

export interface NoteSource {
  readonly artifact: string;
  readonly rel: string;
  readonly context?: string | undefined;
}

export interface MemoryNote {
  readonly id: string;
  readonly title: string;
  readonly status: NoteStatus;
  readonly scope: NoteScope;
  readonly projectSegment: string | null;
  readonly repositoryPath: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly links: ReadonlyArray<NoteLink>;
  readonly sources: ReadonlyArray<NoteSource>;
  readonly created: string;
  readonly modified: string;
  readonly body: string;
}

export type ParsedNote =
  | { readonly kind: "parsed"; readonly note: MemoryNote }
  | { readonly kind: "malformed"; readonly reason: string };

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.flatMap((entry) => asString(entry) ?? []) : [];

const asStatus = (value: unknown): NoteStatus =>
  value === "demoted" || value === "archived" ? value : "active";

const asScope = (value: unknown): NoteScope => (value === "project" ? "project" : "global");

const asLinks = (value: unknown): ReadonlyArray<NoteLink> => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = asString(record.id);
    if (!id) {
      return [];
    }
    const context = asString(record.context);
    return [{ id, rel: asString(record.rel) ?? "see-also", ...(context ? { context } : {}) }];
  });
};

const asSources = (value: unknown): ReadonlyArray<NoteSource> => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const artifact = asString(record.artifact);
    if (!artifact) {
      return [];
    }
    const context = asString(record.context);
    return [
      { artifact, rel: asString(record.rel) ?? "derived-from", ...(context ? { context } : {}) },
    ];
  });
};

/**
 * Parse a note file. Returns a `malformed` result rather than throwing: one bad
 * file must never abort a reindex over the whole corpus.
 */
export function parseNote(contents: string): ParsedNote {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "malformed", reason: "missing frontmatter" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { kind: "malformed", reason: "unparseable yaml" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed", reason: "frontmatter is not a mapping" };
  }

  const record = parsed as Record<string, unknown>;
  const id = asString(record.id);
  if (!id) {
    return { kind: "malformed", reason: "missing id" };
  }

  // A note missing `created` is still worth indexing; epoch sorts it last
  // rather than dropping it.
  const created = asString(record.created) ?? EPOCH_ISO;
  return {
    kind: "parsed",
    note: {
      id,
      title: asString(record.title) ?? id,
      status: asStatus(record.status),
      scope: asScope(record.scope),
      projectSegment: asString(record.project_segment),
      repositoryPath: asString(record.repository_path),
      tags: asStringArray(record.tags),
      links: asLinks(record.links),
      sources: asSources(record.sources),
      created,
      modified: asString(record.modified) ?? created,
      body: contents.slice(match[0].length).trim(),
    },
  };
}

/** Render a note back to markdown. Round-trips with {@link parseNote}. */
export function serializeNote(note: MemoryNote): string {
  const frontmatter = stringifyYaml({
    id: note.id,
    title: note.title,
    status: note.status,
    scope: note.scope,
    ...(note.projectSegment ? { project_segment: note.projectSegment } : {}),
    ...(note.repositoryPath ? { repository_path: note.repositoryPath } : {}),
    tags: [...note.tags],
    links: note.links.map((link) => ({
      id: link.id,
      rel: link.rel,
      ...(link.context ? { context: link.context } : {}),
    })),
    sources: note.sources.map((source) => ({
      artifact: source.artifact,
      rel: source.rel,
      ...(source.context ? { context: source.context } : {}),
    })),
    created: note.created,
    modified: note.modified,
  });
  return `---\n${frontmatter}---\n\n${note.body.trim()}\n`;
}

const notePath = (memoryRoot: string, id: string) =>
  Effect.map(Path.Path, (path) => path.join(memoryRoot, `${id}.md`));

/** Replace this note's index rows. Callers must already hold the file write. */
const indexNote = Effect.fn("memory.indexNote")(function* (note: MemoryNote) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO memory_notes
      (id, title, status, scope, project_segment, repository_path, tags, created_at, modified_at)
    VALUES
      (${note.id}, ${note.title}, ${note.status}, ${note.scope}, ${note.projectSegment},
       ${note.repositoryPath}, ${encodeTags(note.tags)}, ${note.created}, ${note.modified})
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      scope = excluded.scope,
      project_segment = excluded.project_segment,
      repository_path = excluded.repository_path,
      tags = excluded.tags,
      modified_at = excluded.modified_at
  `;

  // Replace rather than merge: the file is authoritative, so a link removed
  // from frontmatter must disappear from the index too.
  yield* sql`DELETE FROM memory_note_links WHERE from_note_id = ${note.id}`;
  for (const link of note.links) {
    yield* sql`
      INSERT INTO memory_note_links (from_note_id, to_note_id, relation, context, created_at)
      VALUES (${note.id}, ${link.id}, ${link.rel}, ${link.context ?? null}, ${note.modified})
      ON CONFLICT(from_note_id, to_note_id) DO UPDATE SET
        relation = excluded.relation, context = excluded.context
    `;
  }

  yield* sql`DELETE FROM memory_note_sources WHERE note_id = ${note.id}`;
  for (const source of note.sources) {
    yield* sql`
      INSERT INTO memory_note_sources (note_id, artifact_id, relation, context, created_at)
      VALUES (${note.id}, ${source.artifact}, ${source.rel}, ${source.context ?? null}, ${note.modified})
      ON CONFLICT(note_id, artifact_id) DO UPDATE SET
        relation = excluded.relation, context = excluded.context
    `;
  }
});

/**
 * Write a note, then index it.
 *
 * File first: a file with no row is repaired by the next reindex, while a row
 * with no file is a dangling reference nothing repairs.
 */
export const writeNote = Effect.fn("memory.writeNote")(function* (input: {
  readonly memoryRoot: string;
  readonly note: MemoryNote;
}) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* notePath(input.memoryRoot, input.note.id);

  yield* fs.makeDirectory(input.memoryRoot, { recursive: true });
  yield* writeFileStringAtomically({ filePath, contents: serializeNote(input.note) });
  yield* indexNote(input.note);
});

/** Read a note from disk. Returns null when absent or malformed. */
export const readNote = Effect.fn("memory.readNote")(function* (input: {
  readonly memoryRoot: string;
  readonly id: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* notePath(input.memoryRoot, input.id);

  if (!(yield* fs.exists(filePath))) {
    return null;
  }
  const parsed = parseNote(yield* fs.readFileString(filePath));
  return parsed.kind === "parsed" ? parsed.note : null;
});

export interface NoteIndexRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly scope: string;
  readonly project_segment: string | null;
  readonly tags: string;
  readonly modified_at: string;
}

const DEFAULT_LIST_LIMIT = 200;

/**
 * List notes from the index, current project first.
 *
 * Filters are expressed as `(param IS NULL OR column = param)` so the query
 * stays a single prepared statement instead of string-built SQL.
 */
export const listNotes = Effect.fn("memory.listNotes")(function* (input: {
  readonly scope?: NoteScope | undefined;
  readonly projectSegment?: string | undefined;
  readonly status?: NoteStatus | undefined;
  readonly tag?: string | undefined;
  readonly limit?: number | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const scope = input.scope ?? null;
  const projectSegment = input.projectSegment ?? null;
  const status = input.status ?? null;
  const tag = input.tag ?? null;
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;

  return yield* sql<NoteIndexRow>`
    SELECT id, title, status, scope, project_segment, tags, modified_at
    FROM memory_notes
    WHERE (${scope} IS NULL OR scope = ${scope})
      AND (${projectSegment} IS NULL OR project_segment = ${projectSegment})
      AND (${status} IS NULL OR status = ${status})
      AND (${tag} IS NULL OR EXISTS (
        SELECT 1 FROM json_each(memory_notes.tags) WHERE json_each.value = ${tag}
      ))
    ORDER BY
      CASE WHEN project_segment = ${projectSegment} THEN 0 ELSE 1 END,
      modified_at DESC
    LIMIT ${limit}
  `;
});

export interface BacklinkRow {
  readonly from_note_id: string;
  readonly relation: string;
  readonly context: string | null;
  readonly title: string | null;
}

/** Which notes link to this one. Indexed on `to_note_id`, never a scan. */
export const backlinksFor = Effect.fn("memory.backlinksFor")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<BacklinkRow>`
    SELECT links.from_note_id, links.relation, links.context, notes.title
    FROM memory_note_links AS links
    LEFT JOIN memory_notes AS notes ON notes.id = links.from_note_id
    WHERE links.to_note_id = ${id}
    ORDER BY links.from_note_id
  `;
});

export interface ReindexResult {
  readonly indexed: number;
  readonly skipped: ReadonlyArray<{ readonly file: string; readonly reason: string }>;
}

/**
 * Rebuild the index from the markdown corpus.
 *
 * Consolidation runs this first, which is what makes hand edits self-healing:
 * a file edited outside the app desyncs the index for at most one cycle. A
 * malformed file is reported and skipped, never fatal -- one bad note must not
 * block indexing every healthy one.
 */
export const reindexAll = Effect.fn("memory.reindexAll")(function* (input: {
  readonly memoryRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* fs.exists(input.memoryRoot))) {
    return { indexed: 0, skipped: [] } satisfies ReindexResult;
  }

  const entries = yield* fs.readDirectory(input.memoryRoot);
  const noteFiles = entries.filter(
    (entry) => entry.endsWith(".md") && !isReservedMemoryFile(entry),
  );

  // Rebuild from scratch so notes deleted on disk leave the index too.
  yield* sql`DELETE FROM memory_note_links`;
  yield* sql`DELETE FROM memory_note_sources`;
  yield* sql`DELETE FROM memory_notes`;

  const skipped: Array<{ file: string; reason: string }> = [];
  let indexed = 0;

  for (const file of noteFiles) {
    const contents = yield* fs.readFileString(path.join(input.memoryRoot, file));
    const parsed = parseNote(contents);
    if (parsed.kind === "malformed") {
      skipped.push({ file, reason: parsed.reason });
      continue;
    }
    yield* indexNote(parsed.note);
    indexed += 1;
  }

  return { indexed, skipped } satisfies ReindexResult;
});
