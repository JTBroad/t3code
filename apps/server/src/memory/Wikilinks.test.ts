import { describe, expect, it } from "@effect/vitest";

import { normalizeTitle, parseWikilinks, resolveWikilinks } from "./Wikilinks.ts";

describe("parseWikilinks", () => {
  it("finds targets and keeps reading order", () => {
    expect(parseWikilinks("see [[Guard Migrations]] and [[Reindex]]")).toEqual([
      "Guard Migrations",
      "Reindex",
    ]);
  });

  it("takes the target, not the display text", () => {
    expect(parseWikilinks("[[Guard Migrations|how we guard them]]")).toEqual(["Guard Migrations"]);
  });

  // Linking twice to the same note is one link, and the index's primary key
  // agrees, so a duplicate would be an insert conflict rather than a second edge.
  it("deduplicates case- and whitespace-insensitively", () => {
    expect(parseWikilinks("[[Guard Migrations]] then [[guard   migrations]]")).toEqual([
      "Guard Migrations",
    ]);
  });

  // A note documenting this very syntax would otherwise link itself to every
  // example it contains.
  it("ignores links inside fenced code blocks", () => {
    const body = ["before [[Real]]", "```md", "[[Not A Link]]", "```", "after"].join("\n");
    expect(parseWikilinks(body)).toEqual(["Real"]);
  });

  it("ignores links inside inline code", () => {
    expect(parseWikilinks("write `[[Example]]` to link, like [[Real]]")).toEqual(["Real"]);
  });

  it("ignores empty and malformed brackets", () => {
    expect(parseWikilinks("[[]] [[   ]] [not a link] [[unclosed")).toEqual([]);
  });

  it("normalizes titles for comparison only", () => {
    expect(normalizeTitle("  Guard   Migrations ")).toBe("guard migrations");
    // The parsed target keeps its original casing so the UI can show what was typed.
    expect(parseWikilinks("[[Guard Migrations]]")).toEqual(["Guard Migrations"]);
  });
});

describe("resolveWikilinks", () => {
  const candidates = (entries: Record<string, ReadonlyArray<string>>) =>
    new Map(Object.entries(entries).map(([title, ids]) => [normalizeTitle(title), ids]));

  it("resolves a unique title", () => {
    const [resolved] = resolveWikilinks({
      fromNoteId: "n_from",
      targets: ["Guard Migrations"],
      candidatesByTitle: candidates({ "Guard Migrations": ["n_guard"] }),
    });
    expect(resolved).toEqual({
      targetTitle: "Guard Migrations",
      toNoteId: "n_guard",
      isAmbiguous: false,
    });
  });

  // An unresolved link is a normal state -- "a note worth writing later" -- not an
  // error, which is why the row is stored rather than dropped.
  it("keeps an unresolved link with a null target", () => {
    const [resolved] = resolveWikilinks({
      fromNoteId: "n_from",
      targets: ["Never Written"],
      candidatesByTitle: candidates({}),
    });
    expect(resolved?.toNoteId).toBeNull();
    expect(resolved?.isAmbiguous).toBe(false);
  });

  // Titles are not unique. Resolving imperfectly beats refusing to resolve, but
  // the flag is what lets the UI say so instead of silently picking.
  it("resolves an ambiguous title to the first candidate and flags it", () => {
    const [resolved] = resolveWikilinks({
      fromNoteId: "n_from",
      targets: ["Notes"],
      candidatesByTitle: candidates({ Notes: ["n_recent", "n_older"] }),
    });
    expect(resolved?.toNoteId).toBe("n_recent");
    expect(resolved?.isAmbiguous).toBe(true);
  });

  // A self backlink is noise in every view that shows backlinks.
  it("never links a note to itself", () => {
    const [resolved] = resolveWikilinks({
      fromNoteId: "n_self",
      targets: ["Self"],
      candidatesByTitle: candidates({ Self: ["n_self"] }),
    });
    expect(resolved?.toNoteId).toBeNull();
  });

  it("does not count itself toward ambiguity", () => {
    const [resolved] = resolveWikilinks({
      fromNoteId: "n_self",
      targets: ["Shared"],
      candidatesByTitle: candidates({ Shared: ["n_self", "n_other"] }),
    });
    expect(resolved?.toNoteId).toBe("n_other");
    expect(resolved?.isAmbiguous).toBe(false);
  });
});
