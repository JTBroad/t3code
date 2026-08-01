import { describe, expect, it } from "vite-plus/test";

import {
  BRIEF_TOTAL_BUDGET,
  clampToBudget,
  composeBrief,
  countContinuitySignals,
  formatThemes,
  rankNotes,
  SECTION_BUDGETS,
} from "./ContinuityBrief.ts";
import type { NoteIndexRow } from "./NoteStore.ts";

const row = (overrides: Partial<NoteIndexRow>): NoteIndexRow => ({
  id: "n1",
  title: "A note",
  status: "active",
  scope: "global",
  project_segment: null,
  tags: "[]",
  modified_at: "2026-08-01T12:00:00Z",
  ...overrides,
});

const huge = (marker: string) => `${marker} `.repeat(2_000);

describe("budgets", () => {
  // Adversarial input is the case that matters: a brief that can grow without
  // bound is prompt bloat with extra steps.
  it("never exceeds the total budget even when every section is oversized", () => {
    const brief = composeBrief({
      identity: huge("identity"),
      daily: huge("daily"),
      brief: huge("brief"),
      themes: huge("themes"),
    });

    expect(brief.length).toBeLessThanOrEqual(BRIEF_TOTAL_BUDGET);
  });

  it("caps each section independently", () => {
    const identityOnly = composeBrief({ identity: huge("identity") });
    // Section content plus its heading, still comfortably inside the total.
    expect(identityOnly.length).toBeLessThanOrEqual(SECTION_BUDGETS.identity + 100);

    const dailyOnly = composeBrief({ daily: huge("daily") });
    expect(dailyOnly.length).toBeLessThanOrEqual(SECTION_BUDGETS.daily + 100);
  });

  it("does not cut mid-word when it can avoid it", () => {
    const clamped = clampToBudget("alpha beta gamma delta epsilon", 20);
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped).not.toContain("epsil");
  });

  it("leaves text under budget untouched", () => {
    expect(clampToBudget("short", 100)).toBe("short");
  });
});

describe("silence when nothing happened", () => {
  // A digest that always fires trains the model to ignore it.
  it("emits nothing when every section is empty", () => {
    expect(composeBrief({})).toBe("");
    expect(composeBrief({ identity: "", daily: "   ", themes: "\n" })).toBe("");
  });

  it("emits only the sections that have content", () => {
    const brief = composeBrief({ identity: "Prefers guarded migrations." });
    expect(brief).toContain("About the user");
    expect(brief).not.toContain("Themes");
    expect(brief).not.toContain("Captured since");
  });
});

describe("ranking", () => {
  it("puts current-project notes ahead of global ones despite recency", () => {
    const ranked = rankNotes(
      [
        row({ id: "global-newer", modified_at: "2026-08-01T23:00:00Z" }),
        row({
          id: "project-older",
          scope: "project",
          project_segment: "api-3f9c01",
          modified_at: "2026-08-01T01:00:00Z",
        }),
      ],
      "api-3f9c01",
    );

    expect(ranked.map((note) => note.id)).toEqual(["project-older", "global-newer"]);
  });

  it("falls back to recency within the same locality", () => {
    const ranked = rankNotes(
      [
        row({ id: "older", modified_at: "2026-08-01T01:00:00Z" }),
        row({ id: "newer", modified_at: "2026-08-01T23:00:00Z" }),
      ],
      null,
    );

    expect(ranked.map((note) => note.id)).toEqual(["newer", "older"]);
  });

  it("ranks purely by recency when there is no current project", () => {
    const ranked = rankNotes(
      [
        row({ id: "a", project_segment: "api-3f9c01", modified_at: "2026-08-01T01:00:00Z" }),
        row({ id: "b", modified_at: "2026-08-01T23:00:00Z" }),
      ],
      null,
    );

    expect(ranked[0]?.id).toBe("b");
  });

  it("renders themes as a plain list", () => {
    expect(
      formatThemes([
        { id: "n1", title: "Guard migrations", scope: "global", projectSegment: null },
      ]),
    ).toBe("- Guard migrations");
  });
});

describe("signal count", () => {
  it("counts sections, not lines", () => {
    // A long daily buffer is one signal, not one per line.
    const brief = composeBrief({
      daily: "line one\nline two\nline three",
      themes: "- a\n- b",
    });

    expect(countContinuitySignals(brief)).toBe(2);
  });

  it("is zero for an empty brief", () => {
    expect(countContinuitySignals("")).toBe(0);
  });
});
