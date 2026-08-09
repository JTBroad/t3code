/**
 * 042_MemoryVaultIndex - Tombstone.
 *
 * This briefly created the vault's full-text and wikilink tables in the core
 * database. They moved to the memory app's own store before shipping, so this
 * creates nothing.
 *
 * Kept and still numbered 42 for the same reason as `039_MemoryAndDrive`: a
 * database that ran it has the id recorded, and renumbering the sequence around
 * it would make every such database disagree with the manifest.
 */
import * as Effect from "effect/Effect";

export default Effect.void;
