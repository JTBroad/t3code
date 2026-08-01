import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  appendDailyEntry,
  clearDaily,
  DAILY_FILENAME,
  DAILY_SCAFFOLD,
  isReservedMemoryFile,
  readDaily,
  rotateDaily,
} from "./DailyStore.ts";

type Provenance = Parameters<typeof appendDailyEntry>[0]["provenance"];

const provenance = (overrides: Partial<Provenance> = {}): Provenance => ({
  capturedAt: "2026-08-01T12:00:00Z",
  projectSegment: "t3code-a41f2c",
  threadId: "th_9f2c",
  ...overrides,
});

/** Fresh temp memory root per test, removed when the scope closes. */
const withMemoryRoot = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-daily-" });
});

it.layer(NodeServices.layer)("DailyStore", (it) => {
  it.effect("stamps each entry with server-supplied provenance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();

        yield* appendDailyEntry({
          memoryRoot,
          body: "Prefers migrations reviewed for idempotency before landing.",
          provenance: provenance(),
        });

        const contents = yield* readDaily({ memoryRoot });
        expect(contents).toContain("## 2026-08-01T12:00:00Z · t3code-a41f2c · thread th_9f2c");
        expect(contents).toContain("Prefers migrations reviewed for idempotency");
      }),
    ),
  );

  it.effect("marks provenance unattributed rather than dropping the observation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();

        yield* appendDailyEntry({
          memoryRoot,
          body: "Observed with no resolvable repository.",
          provenance: provenance({ projectSegment: null, threadId: null }),
        });

        const contents = yield* readDaily({ memoryRoot });
        expect(contents).toContain("· unattributed · thread unattributed");
        expect(contents).toContain("Observed with no resolvable repository.");
      }),
    ),
  );

  it.effect("redacts the body before it reaches disk", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();
        const fakeToken = `ghp_${"x".repeat(36)}`;

        const result = yield* appendDailyEntry({
          memoryRoot,
          body: `Deploy needs ${fakeToken} exported first.`,
          provenance: provenance(),
        });

        const contents = yield* readDaily({ memoryRoot });
        expect(contents).not.toContain(fakeToken);
        expect(contents).toContain("[redacted:github-token]");
        expect(result.redactions.map((redaction) => redaction.kind)).toEqual(["github-token"]);
      }),
    ),
  );

  // The regression guard for the read-modify-write trap. Several sessions
  // across several projects append to this one file, and losing an observation
  // here would be silent and unrecoverable.
  it.effect("keeps every entry when twenty captures land concurrently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();
        const bodies = Array.from(
          { length: 20 },
          (_unused, index) => `observation number ${index}`,
        );

        yield* Effect.all(
          bodies.map((body, index) =>
            appendDailyEntry({
              memoryRoot,
              body,
              provenance: provenance({ threadId: `th_${index}` }),
            }),
          ),
          { concurrency: "unbounded" },
        );

        const contents = yield* readDaily({ memoryRoot });
        expect(contents.match(/^## /gm)?.length ?? 0).toBe(20);
        for (const body of bodies) {
          expect(contents).toContain(body);
        }
      }),
    ),
  );

  it.effect("reads empty before anything has been captured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();
        expect(yield* readDaily({ memoryRoot })).toBe("");
      }),
    ),
  );

  it.effect("resets to the scaffold when cleared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();

        yield* appendDailyEntry({ memoryRoot, body: "something", provenance: provenance() });
        yield* clearDaily({ memoryRoot });

        expect(yield* readDaily({ memoryRoot })).toBe(DAILY_SCAFFOLD);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("DailyStore rotation", (it) => {
  it.effect("moves the buffer aside so a mid-run capture is not lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const memoryRoot = yield* withMemoryRoot();

        yield* appendDailyEntry({ memoryRoot, body: "captured before", provenance: provenance() });

        const rotated = yield* rotateDaily({ memoryRoot, rotatedAt: "2026-08-01T13:00:00Z" });
        assert.ok(rotated, "expected a rotation");
        expect(rotated.contents).toContain("captured before");

        // An append landing after the rotation starts a fresh buffer and is
        // picked up next cycle rather than being cleared unpromoted.
        yield* appendDailyEntry({ memoryRoot, body: "captured during", provenance: provenance() });

        const current = yield* readDaily({ memoryRoot });
        expect(current).toContain("captured during");
        expect(current).not.toContain("captured before");

        // The rotated file stays on disk so a failed run can retry it.
        expect(yield* fs.exists(rotated.path)).toBe(true);
        expect(path.basename(rotated.path)).not.toBe(DAILY_FILENAME);
      }),
    ),
  );

  it.effect("returns null when there is nothing worth rotating", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memoryRoot = yield* withMemoryRoot();

        expect(yield* rotateDaily({ memoryRoot, rotatedAt: "2026-08-01T13:00:00Z" })).toBeNull();

        yield* clearDaily({ memoryRoot });
        expect(yield* rotateDaily({ memoryRoot, rotatedAt: "2026-08-01T13:00:00Z" })).toBeNull();
      }),
    ),
  );
});

it("reserves the buffer, rotated buffers, and the index from note reindexing", () => {
  expect(isReservedMemoryFile("daily.md")).toBe(true);
  expect(isReservedMemoryFile("_index.md")).toBe(true);
  expect(isReservedMemoryFile("daily.2026-08-01T13-00-00Z.pending.md")).toBe(true);
  expect(isReservedMemoryFile("202608011412.md")).toBe(false);
});
