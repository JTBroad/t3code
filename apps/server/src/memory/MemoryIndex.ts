/**
 * MemoryIndex - The one way the vault's index gets rebuilt.
 *
 * Three things trigger reindexing, and before this module they had no common
 * path: consolidation (which called `reindexAll` directly), a user asking for it,
 * and now a file watcher. All three go through here, for one reason:
 *
 * ## Reindexing is serialized behind a single lock
 *
 * Agents write notes mid-turn via the MCP tools, the watcher sees those same
 * writes, and consolidation runs on its own schedule. That is three writers over
 * one corpus. They are safe because reindexing a file twice is a no-op *and* no
 * two passes run at once -- idempotence alone would not prevent a full rebuild's
 * `DELETE FROM memory_notes` from landing in the middle of an incremental pass.
 *
 * ## The watcher tolerates sync tools
 *
 * The whole point of a plain-markdown vault is that people put it in git,
 * Dropbox, or iCloud. Those write in bursts, produce half-written files, and
 * have unreliable mtimes. So: events are debounced rather than acted on
 * individually, a file that fails to parse is left indexed as it was and retried
 * on the next event, and a full reindex at startup is the backstop for anything
 * missed while the server was down.
 *
 * @module MemoryIndex
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { reindexDrive } from "./ArtifactStore.ts";
import { isReservedMemoryFile } from "./DailyStore.ts";
import { resolveDriveRoot, resolveMemoryRoot } from "./MemoryPaths.ts";
import { reindexAll, reindexNoteFile } from "./NoteStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/**
 * How long to wait for writes to stop before reindexing.
 *
 * Tuned for sync tools rather than for a human typing: Dropbox and git checkouts
 * land many files in a burst, and reindexing after each one would rebuild the
 * title map dozens of times for one logical change. Long enough to coalesce a
 * burst, short enough that a hand edit shows up while the user is still looking
 * at the app.
 */
export const WATCH_DEBOUNCE_MS = 750;

export class MemoryIndex extends Context.Service<
  MemoryIndex,
  {
    /**
     * Rebuild the whole index -- notes and drive -- from disk.
     *
     * The correctness backstop. Everything else is an optimization over this.
     */
    readonly reindexEverything: Effect.Effect<{
      readonly notesIndexed: number;
      readonly artifactsIndexed: number;
    }>;

    /**
     * Reindex the notes under a specific root, leaving the drive index alone.
     *
     * Consolidation's entry point. It is handed a root explicitly rather than
     * resolving one, so it must be able to say which corpus to refresh -- and it
     * has no business rebuilding the drive index, which would mean a
     * consolidation run could drop artifact rows it never looked at.
     */
    readonly reindexNotesIn: (memoryRoot: string) => Effect.Effect<void>;

    /** Reindex one note file by name, for the watcher's incremental path. */
    readonly reindexNote: (fileName: string) => Effect.Effect<void>;

    /**
     * Watch the vault and reindex as it changes.
     *
     * Runs until the scope closes. Never fails: a platform without usable file
     * watching should lose live updates, not the server.
     */
    readonly watch: Effect.Effect<void>;
  }
>()("t3/memory/MemoryIndex") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService;
  const config = yield* ServerConfig;

  /**
   * One permit, held by every reindex path.
   *
   * The invariant the concurrency story rests on. Cheap to hold: a full reindex
   * of a corpus this size is milliseconds, and the alternative is a torn index.
   */
  const lock = yield* Semaphore.make(1);

  const roots = Effect.gen(function* () {
    const settings = yield* Effect.orElseSucceed(settingsService.getSettings, () => null);
    return {
      memoryRoot: settings ? resolveMemoryRoot(settings, config) : config.memoryDir,
      driveRoot: settings ? resolveDriveRoot(settings, config) : config.driveDir,
    };
  });

  const reindexEverything = Effect.gen(function* () {
    const { memoryRoot, driveRoot } = yield* roots;
    const notes = yield* reindexAll({ memoryRoot });
    const artifacts = yield* reindexDrive({ driveRoot });

    if (notes.skipped.length > 0 || artifacts.skipped.length > 0) {
      // Skips are normal for a hand-edited vault, so this is not a warning --
      // but it must be visible, or a note silently missing from search has no
      // explanation anywhere.
      yield* Effect.logInfo("memory reindex skipped some files", {
        notes: notes.skipped,
        artifacts: artifacts.skipped,
      });
    }

    return { notesIndexed: notes.indexed, artifactsIndexed: artifacts.indexed };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("memory reindex failed", { cause }).pipe(
        Effect.as({ notesIndexed: 0, artifactsIndexed: 0 }),
      ),
    ),
    lock.withPermits(1),
  );

  const reindexNotesIn = (memoryRoot: string) =>
    reindexAll({ memoryRoot }).pipe(
      Effect.tap((result) =>
        result.skipped.length === 0
          ? Effect.void
          : Effect.logInfo("memory reindex skipped some notes", { skipped: result.skipped }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("memory note reindex failed", { cause })),
      Effect.asVoid,
      lock.withPermits(1),
    );

  const reindexNote = (fileName: string) =>
    Effect.gen(function* () {
      const { memoryRoot } = yield* roots;
      const result = yield* reindexNoteFile({ memoryRoot, fileName });
      if (!result.indexed && result.reason !== "deleted") {
        // Left as it was rather than dropped: a half-written file from a sync
        // tool is the common case, and the next event retries it.
        yield* Effect.logDebug("memory note not reindexed", {
          fileName,
          reason: result.reason,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("memory note reindex failed", { fileName, cause }),
      ),
      lock.withPermits(1),
    );

  /**
   * Coalesce a burst of events, then reindex the files it touched.
   *
   * Debounced per burst rather than per file: a git checkout that rewrites forty
   * notes should produce one pass, and `Stream.debounce` keeping only the latest
   * event would drop the other thirty-nine, so events are grouped by time
   * window instead.
   */
  const watch = Effect.gen(function* () {
    const { memoryRoot } = yield* roots;
    yield* fs.makeDirectory(memoryRoot, { recursive: true });

    yield* fs.watch(memoryRoot).pipe(
      Stream.map((event) => path.basename(event.path)),
      Stream.filter((fileName) => fileName.endsWith(".md") && !isReservedMemoryFile(fileName)),
      Stream.groupedWithin(256, Duration.millis(WATCH_DEBOUNCE_MS)),
      Stream.runForEach((batch) =>
        Effect.forEach(new Set(batch), (fileName) => reindexNote(fileName), {
          discard: true,
        }),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) =>
      // Live updates are a convenience; the startup reindex and consolidation
      // still keep the index correct without them.
      Effect.logWarning("memory vault watching unavailable", { cause }),
    ),
  );

  return {
    reindexEverything,
    reindexNotesIn,
    reindexNote,
    watch,
  } satisfies MemoryIndex["Service"];
});

export const layer = Layer.effect(MemoryIndex, make);

/**
 * Reindex once at startup, then watch in the background.
 *
 * The startup pass is what makes edits made while the server was down show up,
 * and it is the correctness backstop for every incremental path. Forked so a
 * large vault does not delay the server accepting connections.
 */
export const startupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const index = yield* MemoryIndex;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const result = yield* index.reindexEverything;
        yield* Effect.logDebug("memory index ready", result);
        yield* index.watch;
      }),
    );
    return yield* Effect.void;
  }),
).pipe(Layer.provideMerge(layer));
