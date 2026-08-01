/**
 * Consolidation - Promote short-term captures into permanent notes.
 *
 * The ordering in {@link runConsolidation} is the design, not an
 * implementation detail:
 *
 *  1. take the lock, so two runs cannot interleave promotions
 *  2. reindex, which is what makes hand-edited files self-healing
 *  3. rotate the buffer aside, so captures landing mid-run are not destroyed
 *  4. promote entries into notes
 *  5. write a summary somewhere this run never reads back
 *  6. release the rotated buffer only after promotion succeeded
 *
 * The rule that is easiest to violate: a cycle must not consume its own
 * output. The summary goes to a `receipts/` subdirectory that the note reindex
 * skips and the input set never includes. Without that, each run spends more of
 * its budget reprocessing its own exhaust until it does nothing else.
 *
 * @module Consolidation
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { artifactsCreatedSince } from "./ArtifactStore.ts";
import { DAILY_SCAFFOLD, rotateDaily } from "./DailyStore.ts";
import { reindexAll, writeNote, type MemoryNote } from "./NoteStore.ts";

/** Summaries live here. The note reindex ignores the whole directory. */
export const RECEIPTS_DIRNAME = "receipts";

const LOCK_FILENAME = ".consolidation.lock";
const MARKER_FILENAME = ".last-consolidated";

export type ConsolidationOutcome =
  | {
      readonly kind: "completed";
      readonly promoted: number;
      readonly entriesRead: number;
      readonly artifactsConsulted: number;
      readonly summaryPath: string;
    }
  | { readonly kind: "already-running" }
  | { readonly kind: "nothing-to-do" };

export interface DailyEntry {
  readonly capturedAt: string;
  readonly projectSegment: string | null;
  readonly threadId: string | null;
  readonly body: string;
}

const ENTRY_HEADER = /^## (\S+) · (\S+) · thread (\S+)$/;

/**
 * Split a rotated buffer back into entries.
 *
 * Reads the provenance header the capture tool wrote, which is the only way a
 * promoted note can get its scope right.
 */
export function parseDailyEntries(contents: string): ReadonlyArray<DailyEntry> {
  const entries: Array<DailyEntry> = [];
  let current: { header: RegExpExecArray; lines: Array<string> } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const body = current.lines.join("\n").trim();
    if (body.length > 0) {
      entries.push({
        capturedAt: current.header[1] ?? "",
        projectSegment: current.header[2] === "unattributed" ? null : (current.header[2] ?? null),
        threadId: current.header[3] === "unattributed" ? null : (current.header[3] ?? null),
        body,
      });
    }
    current = null;
  };

  for (const line of contents.split("\n")) {
    const header = ENTRY_HEADER.exec(line.trim());
    if (header) {
      flush();
      current = { header, lines: [] };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return entries;
}

/**
 * Timestamp-based note id, matching the Zettelkasten convention.
 *
 * Disambiguated by a short digest of the body rather than the entry's position
 * in its run. Position-based ids collide whenever two observations share a
 * capture timestamp across different runs, and the collision is silent: the
 * second note overwrites the first. Hashing the body also makes re-promoting
 * an identical observation idempotent instead of duplicating it.
 */
export function noteIdFor(capturedAt: string, body: string): string {
  const digits = capturedAt.replace(/\D/g, "").slice(0, 12).padEnd(12, "0");
  const digest = NodeCrypto.createHash("sha256").update(body).digest("hex").slice(0, 4);
  return `${digits}${digest}`;
}

const titleFor = (body: string): string => {
  const firstLine = body.split("\n")[0]?.trim() ?? "Untitled";
  return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
};

/** Acquire the single-writer lock, or report that a run is already in flight. */
const acquireLock = Effect.fn("memory.acquireConsolidationLock")(function* (memoryRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(memoryRoot, LOCK_FILENAME);

  yield* fs.makeDirectory(memoryRoot, { recursive: true });
  // "wx" fails when the file exists, which makes creation the atomic test.
  const acquired = yield* fs.writeFileString(lockPath, "locked", { flag: "wx" }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return { acquired, lockPath };
});

export const readLastConsolidatedAt = Effect.fn("memory.readLastConsolidatedAt")(function* (
  memoryRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const markerPath = path.join(memoryRoot, MARKER_FILENAME);
  if (!(yield* fs.exists(markerPath))) {
    return null;
  }
  const contents = (yield* fs.readFileString(markerPath)).trim();
  return contents.length > 0 ? contents : null;
});

/**
 * Run one consolidation.
 *
 * Failure preserves captured data: the rotated buffer is left on disk and the
 * marker is not advanced, so the next run reconsiders the same entries.
 */
export const runConsolidation = Effect.fn("memory.runConsolidation")(function* (input: {
  readonly memoryRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const { acquired, lockPath } = yield* Effect.orDie(acquireLock(input.memoryRoot));
  if (!acquired) {
    return { kind: "already-running" } as const;
  }

  return yield* Effect.ensuring(
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);

      // Hand-edited files desync the index for at most one cycle.
      yield* reindexAll({ memoryRoot: input.memoryRoot });

      const rotated = yield* rotateDaily({ memoryRoot: input.memoryRoot, rotatedAt: now });
      if (!rotated) {
        return { kind: "nothing-to-do" } as const;
      }

      const entries = parseDailyEntries(rotated.contents);
      const since = yield* readLastConsolidatedAt(input.memoryRoot);
      const artifacts = yield* artifactsCreatedSince({ since });

      let promoted = 0;
      for (const entry of entries) {
        const note: MemoryNote = {
          id: noteIdFor(entry.capturedAt || now, entry.body),
          title: titleFor(entry.body),
          status: "active",
          scope: entry.projectSegment ? "project" : "global",
          projectSegment: entry.projectSegment,
          repositoryPath: null,
          tags: [],
          links: [],
          // Artifacts from the same project are the evidence behind the note.
          sources: artifacts
            .filter((artifact) => artifact.project_segment === entry.projectSegment)
            .slice(0, 5)
            .map((artifact) => ({
              artifact: artifact.id,
              rel: "derived-from",
              context: `Produced during the same window (${artifact.relative_path}).`,
            })),
          created: entry.capturedAt || now,
          modified: now,
          body: entry.body,
        };
        yield* writeNote({ memoryRoot: input.memoryRoot, note });
        promoted += 1;
      }

      const summaryPath = yield* writeSummary({
        memoryRoot: input.memoryRoot,
        now,
        promoted,
        entriesRead: entries.length,
        artifactsConsulted: artifacts.length,
      });

      // Only now is the captured data safe to discard, and only now does the
      // marker advance -- a failure above leaves both for the next run.
      yield* fs.remove(rotated.path).pipe(Effect.orElseSucceed(() => undefined));
      yield* writeFileStringAtomically({
        filePath: path.join(input.memoryRoot, MARKER_FILENAME),
        contents: now,
      });
      yield* writeFileStringAtomically({
        filePath: path.join(input.memoryRoot, "daily.md"),
        contents: DAILY_SCAFFOLD,
      }).pipe(Effect.orElseSucceed(() => undefined));

      return {
        kind: "completed",
        promoted,
        entriesRead: entries.length,
        artifactsConsulted: artifacts.length,
        summaryPath,
      } as const;
    }),
    // Released even on failure or interruption, so a crash cannot wedge the
    // lock permanently.
    fs.remove(lockPath).pipe(Effect.orElseSucceed(() => undefined)),
  ).pipe(Effect.orDie);
});

const writeSummary = Effect.fn("memory.writeConsolidationSummary")(function* (input: {
  readonly memoryRoot: string;
  readonly now: string;
  readonly promoted: number;
  readonly entriesRead: number;
  readonly artifactsConsulted: number;
}) {
  const path = yield* Path.Path;
  const stamp = input.now.replace(/[:.]/g, "-");
  const summaryPath = path.join(input.memoryRoot, RECEIPTS_DIRNAME, `${stamp}.md`);

  const contents = [
    `# Consolidation ${input.now}`,
    "",
    `- Entries read: ${input.entriesRead}`,
    `- Notes promoted: ${input.promoted}`,
    `- Artifacts consulted: ${input.artifactsConsulted}`,
    "",
    input.promoted === 0 ? "Heartbeat: no activity." : "",
  ].join("\n");

  yield* writeFileStringAtomically({ filePath: summaryPath, contents });
  return summaryPath;
});
