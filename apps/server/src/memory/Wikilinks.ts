/**
 * Wikilinks - `[[Title]]` references inside a note's body.
 *
 * Frontmatter `links` are the curated graph: explicit ids, a relation, and a
 * context sentence. Wikilinks are what someone types mid-sentence while writing,
 * and the two behave differently enough to stay separate:
 *
 * - a wikilink names a *title*, not an id, because a title is what a person
 *   remembers
 * - a wikilink may not resolve at all, and that is a normal state rather than an
 *   error -- an unresolved `[[…]]` marks a note worth writing later, which is
 *   how Obsidian users already work
 *
 * Parsing is deliberately conservative. `[[…]]` inside a fenced code block or
 * inline code is left alone: a note about this very syntax would otherwise link
 * itself to every example it contains.
 *
 * @module Wikilinks
 */

/** `[[Title]]` or `[[Title|display text]]`, non-greedy so `[[a]] [[b]]` is two. */
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Fenced code blocks (``` or ~~~) and inline code spans. */
const FENCED_CODE_PATTERN = /^([`~]{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;

/**
 * Blank out code regions while preserving offsets and newlines.
 *
 * Replacing with same-length filler rather than deleting keeps any future
 * position-based feature (a link's location in the body) honest, and keeps the
 * line count stable for anything that reports one.
 */
function maskCode(body: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return body.replace(FENCED_CODE_PATTERN, blank).replace(INLINE_CODE_PATTERN, blank);
}

/**
 * Normalize a title for comparison.
 *
 * Case- and whitespace-insensitive, because `[[Guard Migrations]]` and
 * `[[guard  migrations]]` are the same intent and nobody will type a title
 * twice the same way. The note's own title keeps its original casing; only the
 * lookup key is normalized.
 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Distinct wikilink targets in a note body, in first-appearance order.
 *
 * Deduplicated because linking twice to the same note is not two links, and the
 * index's primary key is (from_note_id, target_title) accordingly. Order is
 * preserved so a UI listing them matches reading order.
 */
export function parseWikilinks(body: string): ReadonlyArray<string> {
  const masked = maskCode(body);
  const seen = new Set<string>();
  const targets: Array<string> = [];

  for (const match of masked.matchAll(WIKILINK_PATTERN)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const title = raw.trim().replace(/\s+/g, " ");
    if (title.length === 0) {
      continue;
    }
    const key = normalizeTitle(title);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(title);
  }

  return targets;
}

export interface WikilinkResolution {
  readonly targetTitle: string;
  readonly toNoteId: string | null;
  readonly isAmbiguous: boolean;
}

/**
 * Resolve titles to note ids.
 *
 * `candidatesByTitle` maps a normalized title to every note carrying it, most
 * recently modified first. Titles are not unique, so ambiguity is a case that
 * has to be decided rather than assumed away:
 *
 * - no match resolves to `null`, kept as an unresolved link
 * - one match resolves to it
 * - several resolve to the first (most recently modified) and set
 *   `isAmbiguous`, so the UI can say "this could be one of three" instead of
 *   silently choosing
 *
 * A note never wikilinks to itself, even if it names its own title: a self
 * backlink is noise in every view that shows backlinks.
 */
export function resolveWikilinks(input: {
  readonly fromNoteId: string;
  readonly targets: ReadonlyArray<string>;
  readonly candidatesByTitle: ReadonlyMap<string, ReadonlyArray<string>>;
}): ReadonlyArray<WikilinkResolution> {
  return input.targets.map((targetTitle) => {
    const candidates = (input.candidatesByTitle.get(normalizeTitle(targetTitle)) ?? []).filter(
      (id) => id !== input.fromNoteId,
    );

    return {
      targetTitle,
      toNoteId: candidates[0] ?? null,
      isAmbiguous: candidates.length > 1,
    };
  });
}
