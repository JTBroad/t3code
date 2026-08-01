/**
 * DailyStore - Short-term capture buffer for memory observations.
 *
 * `daily.md` is append-only between consolidations. Every entry carries a
 * provenance header written by the server, never by the model: consolidation
 * needs to know which project an observation came from to set a note's scope,
 * and a model asked to supply that would eventually get it wrong or omit it.
 *
 * Appends use a single O_APPEND write rather than read-modify-write. Several
 * sessions across several projects share this one file, and the atomic
 * temp-file-plus-rename used elsewhere in the server *replaces* a file -- two
 * concurrent captures would each read, each rewrite, and one observation would
 * be lost with nothing to indicate it ever existed.
 *
 * @module DailyStore
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { redactSecrets, type Redaction } from "./Redaction.ts";

export const DAILY_FILENAME = "daily.md";

/** Written when the buffer is emptied, so the file always explains itself. */
export const DAILY_SCAFFOLD = "# Daily\n\nShort-term capture. Consolidation promotes and clears.\n";

export interface DailyProvenance {
  /** ISO-8601 capture time. */
  readonly capturedAt: string;
  /** Project bucket, or null when the thread's repository could not be resolved. */
  readonly projectSegment: string | null;
  /** Originating thread, or null for captures with no thread context. */
  readonly threadId: string | null;
}

export interface AppendDailyResult {
  /** What the redactor removed. Never includes the removed values themselves. */
  readonly redactions: ReadonlyArray<Redaction>;
}

const UNATTRIBUTED = "unattributed";

const dailyPath = (memoryRoot: string) =>
  Effect.map(Path.Path, (path) => path.join(memoryRoot, DAILY_FILENAME));

/**
 * Render the provenance header. Kept machine-parseable on purpose --
 * consolidation reads these back to decide each promoted note's scope.
 */
export function formatDailyHeader(provenance: DailyProvenance): string {
  const segment = provenance.projectSegment ?? UNATTRIBUTED;
  const thread = provenance.threadId ?? UNATTRIBUTED;
  return `## ${provenance.capturedAt} · ${segment} · thread ${thread}`;
}

/**
 * Append one observation.
 *
 * The body is redacted before it reaches disk, and the raw body is never
 * logged, echoed in an error, or returned.
 */
export const appendDailyEntry = Effect.fn("memory.appendDailyEntry")(function* (input: {
  readonly memoryRoot: string;
  readonly body: string;
  readonly provenance: DailyProvenance;
}) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* dailyPath(input.memoryRoot);

  const { text, redactions } = redactSecrets(input.body.trim());
  const entry = `${formatDailyHeader(input.provenance)}\n${text}\n\n`;

  yield* fs.makeDirectory(input.memoryRoot, { recursive: true });
  // One write, O_APPEND: the OS serializes concurrent appends so no entry is
  // lost. Do not "simplify" this to read-modify-write.
  yield* fs.writeFileString(filePath, entry, { flag: "a" });

  return { redactions } satisfies AppendDailyResult;
});

/** Read the buffer, or empty string when nothing has been captured yet. */
export const readDaily = Effect.fn("memory.readDaily")(function* (input: {
  readonly memoryRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = yield* dailyPath(input.memoryRoot);

  const exists = yield* fs.exists(filePath);
  if (!exists) {
    return "";
  }
  return yield* fs.readFileString(filePath);
});

/**
 * Reset the buffer to its scaffold.
 *
 * Prefer {@link rotateDaily} for consolidation: this truncates in place, so an
 * append arriving between a consolidation's read and its clear would be
 * discarded without ever being promoted.
 */
export const clearDaily = Effect.fn("memory.clearDaily")(function* (input: {
  readonly memoryRoot: string;
}) {
  const filePath = yield* dailyPath(input.memoryRoot);
  yield* writeFileStringAtomically({ filePath, contents: DAILY_SCAFFOLD });
});

export interface RotatedDaily {
  /** Path of the rotated file, left in place so a failed run can retry it. */
  readonly path: string;
  readonly contents: string;
}

/**
 * Atomically move the buffer aside for processing.
 *
 * This is the primitive consolidation should use. Renaming first means appends
 * that land mid-run go to a fresh `daily.md` and are picked up next cycle,
 * rather than being cleared away unpromoted. The rotated file stays on disk so
 * a run that fails after rotating can be retried without losing anything.
 *
 * Returns `null` when there is nothing worth rotating.
 */
export const rotateDaily = Effect.fn("memory.rotateDaily")(function* (input: {
  readonly memoryRoot: string;
  readonly rotatedAt: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = yield* dailyPath(input.memoryRoot);

  const exists = yield* fs.exists(filePath);
  if (!exists) {
    return null;
  }

  const contents = yield* fs.readFileString(filePath);
  if (contents.trim().length === 0 || contents.trim() === DAILY_SCAFFOLD.trim()) {
    return null;
  }

  // Colons are legal on POSIX but awkward on Windows and in shells.
  const stamp = input.rotatedAt.replace(/[:.]/g, "-");
  const rotatedPath = path.join(input.memoryRoot, `daily.${stamp}.pending.md`);
  yield* fs.rename(filePath, rotatedPath);

  return { path: rotatedPath, contents } satisfies RotatedDaily;
});

/**
 * True for files the note reindex must skip: the buffer itself, any rotated
 * buffer awaiting consolidation, and the curated index.
 */
export function isReservedMemoryFile(fileName: string): boolean {
  return (
    fileName === DAILY_FILENAME ||
    fileName === "_index.md" ||
    /^daily\..*\.pending\.md$/.test(fileName)
  );
}
