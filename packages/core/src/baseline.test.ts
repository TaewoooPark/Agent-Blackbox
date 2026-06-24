import { describe, expect, it } from "vitest";

import { compareToBaseline, upsertRunSummary, type RunSummary } from "./baseline.js";

const sum = (runId: string, archetype: RunSummary["archetype"], score: number, inputTokens: number, ts = "2026-06-01T00:00:00.000Z"): RunSummary => ({
  runId,
  ts,
  archetype,
  score,
  inputTokens
});

describe("upsertRunSummary", () => {
  it("replaces by runId (no duplicates) and keeps newest within the cap", () => {
    let h: RunSummary[] = [];
    h = upsertRunSummary(h, sum("a", "edit", 50, 1000, "2026-06-01T00:00:00.000Z"));
    h = upsertRunSummary(h, sum("a", "edit", 70, 2000, "2026-06-02T00:00:00.000Z")); // same id → replace
    expect(h).toHaveLength(1);
    expect(h[0]!.score).toBe(70);

    h = upsertRunSummary(h, sum("b", "edit", 60, 1500, "2026-06-03T00:00:00.000Z"));
    h = upsertRunSummary(h, sum("c", "edit", 60, 1500, "2026-06-04T00:00:00.000Z"), 2); // cap 2
    expect(h.map((x) => x.runId)).toEqual(["c", "b"]); // newest first, oldest dropped
  });
});

describe("compareToBaseline", () => {
  const history: RunSummary[] = [
    sum("r1", "research", 80, 100_000),
    sum("r2", "research", 78, 110_000),
    sum("r3", "research", 82, 90_000),
    sum("e1", "edit", 60, 50_000)
  ];

  it("says insufficient until there are enough prior same-archetype runs", () => {
    const c = compareToBaseline(sum("new", "edit", 55, 40_000), history);
    expect(c.verdict).toBe("insufficient");
    expect(c.note).toBe("");
  });

  it("compares against the median of OTHER same-archetype runs", () => {
    const c = compareToBaseline(sum("new", "research", 55, 300_000), history);
    expect(c.sampleSize).toBe(3);
    expect(c.verdict).toBe("worse"); // 55 well below the ~80 median
    expect(c.scoreDelta).toBeLessThan(0);
    expect(c.inputRatio).toBeGreaterThan(2); // ~3× the median tokens
    expect(c.note).toContain("research");
  });

  it("excludes the run itself from its own baseline", () => {
    // 'r1' is in history; comparing r1 must use only r2/r3 (2 peers < MIN) → insufficient.
    const c = compareToBaseline(sum("r1", "research", 80, 100_000), history);
    expect(c.sampleSize).toBe(2);
    expect(c.verdict).toBe("insufficient");
  });

  it("calls an above-usual run better", () => {
    const c = compareToBaseline(sum("new", "research", 95, 80_000), history);
    expect(c.verdict).toBe("better");
  });
});
