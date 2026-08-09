/**
 * 039_MemoryAndDrive - Tombstone.
 *
 * This once created the memory and drive index tables in the core database.
 * Those tables now live in the memory app's own store at
 * `<stateDir>/apps/memory/state.sqlite`, with their own migration sequence
 * starting at 001.
 *
 * The entry stays, and stays numbered 39, because databases that already ran it
 * record it in `effect_sql_migrations`. Removing it would renumber everything
 * after it and make every existing database disagree with the manifest -- the
 * exact class of failure that `040_ProjectionThreadsPinnedRepair` exists to
 * repair.
 *
 * The tables it used to create are left alone on databases that have them. They
 * are unused, and dropping them would destroy the only copy of any provenance
 * that `MemoryLegacyImport` has not yet rescued into a sidecar. Reclaiming that
 * space is a separate decision to make once, deliberately, after the import has
 * been in the wild long enough to trust.
 */
import * as Effect from "effect/Effect";

export default Effect.void;
