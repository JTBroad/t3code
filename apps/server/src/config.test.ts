import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { deriveServerPaths } from "./config.ts";

const BASE_DIR = "/tmp/t3-derive-paths";
const DEV_URL = new URL("http://localhost:5173");

it.layer(NodeServices.layer)("deriveServerPaths", (it) => {
  it.effect("places the memory and drive stores under the state directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const derived = yield* deriveServerPaths(BASE_DIR, undefined);

      expect(derived.memoryDir).toBe(path.join(derived.stateDir, "memory"));
      expect(derived.driveDir).toBe(path.join(derived.stateDir, "drive"));
    }),
  );

  // The memory store is shared across projects on purpose, but it must never be
  // shared across a dev/test server and a real one: consolidation clears the
  // capture buffer, so a leaked path would let a test run destroy real notes.
  it.effect("keeps dev and production memory and drive stores separate", () =>
    Effect.gen(function* () {
      const production = yield* deriveServerPaths(BASE_DIR, undefined);
      const dev = yield* deriveServerPaths(BASE_DIR, DEV_URL);

      expect(dev.stateDir).not.toBe(production.stateDir);
      expect(dev.memoryDir).not.toBe(production.memoryDir);
      expect(dev.driveDir).not.toBe(production.driveDir);
    }),
  );

  // An explicit --home-dir opts out of the dev split, matching how every other
  // path in this module behaves.
  it.effect("honors an explicit base directory for both stores", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const derived = yield* deriveServerPaths(BASE_DIR, DEV_URL, { baseDirIsExplicit: true });

      expect(derived.stateDir).toBe(path.join(BASE_DIR, "userdata"));
      expect(derived.memoryDir).toBe(path.join(BASE_DIR, "userdata", "memory"));
      expect(derived.driveDir).toBe(path.join(BASE_DIR, "userdata", "drive"));
    }),
  );
});
