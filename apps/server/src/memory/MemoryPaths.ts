/**
 * MemoryPaths - Root resolution and containment for the memory and drive stores.
 *
 * Both roots are user-configurable, which makes the containment guard more
 * important rather than less: every write goes through `resolveWithinRoot`,
 * which rejects anything that escapes the configured root instead of clamping
 * it back inside. The guard is a port of `resolveAttachmentRelativePath` and
 * should stay behaviourally identical to it.
 *
 * @module MemoryPaths
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import type { ServerSettings } from "@t3tools/contracts";

import type { ServerDerivedPaths } from "../config.ts";

/**
 * Length cap for the human-readable half of a project segment. The hash suffix
 * is appended after this, so the full segment stays comfortably inside the
 * shortest filename limit we care about.
 */
const PROJECT_SEGMENT_NAME_MAX_CHARS = 48;

/** Hex characters of the path digest appended to every project segment. */
const PROJECT_SEGMENT_HASH_CHARS = 6;

const trimmedOrNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** Settings keys inside the memory app's own `settings.json`. */
export const MEMORY_ROOT_SETTING_KEY = "memoryRootDirectory";
export const DRIVE_ROOT_SETTING_KEY = "driveRootDirectory";

/**
 * Resolve the memory root.
 *
 * Precedence: the app's own settings file, then the value inherited from core
 * settings, then the `stateDir`-derived default. Never the home directory -- see
 * `deriveServerPaths`.
 *
 * The inherited step is not vestigial. These keys lived in core settings before
 * apps owned their own, and someone who set a custom root must keep it: silently
 * falling back to the default would make their whole vault look empty.
 */
export function resolveMemoryRoot(
  settings: Pick<ServerSettings, "memoryRootDirectory">,
  derivedPaths: Pick<ServerDerivedPaths, "memoryDir">,
  appSettings?: Record<string, unknown> | undefined,
): string {
  return (
    trimmedOrNull(asSettingString(appSettings?.[MEMORY_ROOT_SETTING_KEY])) ??
    trimmedOrNull(settings.memoryRootDirectory) ??
    derivedPaths.memoryDir
  );
}

/** Resolve the drive root, with the same precedence as {@link resolveMemoryRoot}. */
export function resolveDriveRoot(
  settings: Pick<ServerSettings, "driveRootDirectory">,
  derivedPaths: Pick<ServerDerivedPaths, "driveDir">,
  appSettings?: Record<string, unknown> | undefined,
): string {
  return (
    trimmedOrNull(asSettingString(appSettings?.[DRIVE_ROOT_SETTING_KEY])) ??
    trimmedOrNull(settings.driveRootDirectory) ??
    derivedPaths.driveDir
  );
}

const asSettingString = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Normalize a caller-supplied relative path, rejecting anything that could
 * escape its root. Returns `null` rather than a corrected path: a caller that
 * supplied a traversal is a bug or an attack, and silently rewriting it hides
 * both.
 */
export function normalizeStoreRelativePath(rawRelativePath: string): string | null {
  const normalized = NodePath.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

/**
 * Resolve `relativePath` inside `root`, or `null` when the result would fall
 * outside it. The prefix check uses a trailing separator so a sibling root
 * sharing a name prefix (`/store` vs `/store-backup`) cannot pass.
 */
export function resolveWithinRoot(input: {
  readonly root: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeStoreRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const root = NodePath.resolve(input.root);
  const filePath = NodePath.resolve(NodePath.join(root, normalizedRelativePath));
  if (!filePath.startsWith(`${root}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}

/**
 * Filesystem-safe, stable folder name for a repository.
 *
 * The readable half mirrors `toSafeThreadAttachmentSegment`; the hash suffix is
 * what makes it unambiguous. Two checkouts named `api` under different parents
 * must not share a segment, or their notes and artifacts would silently merge
 * into one bucket.
 */
export function toProjectSegment(repositoryPath: string): string | null {
  const trimmed = trimmedOrNull(repositoryPath);
  if (!trimmed) {
    return null;
  }

  const absolutePath = NodePath.resolve(trimmed);
  const name = NodePath.basename(absolutePath)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, PROJECT_SEGMENT_NAME_MAX_CHARS)
    .replace(/[-_]+$/g, "");

  const hash = NodeCrypto.createHash("sha256")
    .update(absolutePath)
    .digest("hex")
    .slice(0, PROJECT_SEGMENT_HASH_CHARS);

  // A path whose basename sanitizes to nothing (say "///") still needs a
  // stable, unique bucket, so fall back to the digest alone.
  return name.length === 0 ? hash : `${name}-${hash}`;
}
