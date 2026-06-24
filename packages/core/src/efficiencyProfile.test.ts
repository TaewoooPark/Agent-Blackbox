import { describe, expect, it } from "vitest";

import { computeEfficiencyReport } from "./efficiency.js";
import { createTraceEvent } from "./events.js";
import { accrueProfile, buildAccumulatedMemory, emptyProfile } from "./efficiencyProfile.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "claude-code", runId: "r", sessionId: "s", kind, payload: payload as never });

// A run that re-reads `file` (redundant-reads → offender) on an edit-oriented task.
const rereadRun = (file: string) =>
  computeEfficiencyReport(
    [
      ev(1, "file_read", { source: "tool.after", path: `$P/${file}`, chars: 60_000 }),
      ev(2, "file_read", { source: "tool.after", path: `$P/${file}`, chars: 60_000 }),
      ev(3, "file_edit", { source: "tool.after", path: `$P/${file}`, chars: 4000 })
    ],
    { archetype: "edit" }
  );

describe("accrueProfile", () => {
  it("is idempotent per runId (re-folding the same run is a no-op)", () => {
    const p1 = accrueProfile(emptyProfile(), rereadRun("a.ts"), { runId: "run-1", ts: "2026-06-01T00:00:00.000Z" });
    const p2 = accrueProfile(p1, rereadRun("a.ts"), { runId: "run-1", ts: "2026-06-01T00:00:00.000Z" });
    expect(p2).toBe(p1); // same reference — nothing changed
    expect(p1.reread.find((i) => i.label.startsWith("a.ts"))?.count).toBe(1);
  });

  it("ranks a recurring offender above a one-off and annotates it ×N", () => {
    let p = emptyProfile();
    p = accrueProfile(p, rereadRun("hot.ts"), { runId: "r1", ts: "2026-06-01T00:00:00.000Z" });
    p = accrueProfile(p, rereadRun("hot.ts"), { runId: "r2", ts: "2026-06-02T00:00:00.000Z" });
    p = accrueProfile(p, rereadRun("hot.ts"), { runId: "r3", ts: "2026-06-03T00:00:00.000Z" });
    p = accrueProfile(p, rereadRun("cold.ts"), { runId: "r4", ts: "2026-06-04T00:00:00.000Z" });

    const hot = p.reread.find((i) => i.label.startsWith("hot.ts"))!;
    const cold = p.reread.find((i) => i.label.startsWith("cold.ts"))!;
    expect(hot.count).toBe(3);
    expect(hot.weight).toBeGreaterThan(cold.weight); // recurring outranks one-off

    const block = buildAccumulatedMemory(p)!;
    expect(block).toContain("hot.ts (×3)");
    expect(block).toContain("accumulated across recent runs");
    // hot.ts is ranked before cold.ts in the rendered list
    expect(block.indexOf("hot.ts")).toBeLessThan(block.indexOf("cold.ts"));
  });

  it("decays and prunes a one-off after enough unrelated runs", () => {
    let p = accrueProfile(emptyProfile(), rereadRun("ghost.ts"), { runId: "g0", ts: "2026-06-01T00:00:00.000Z" });
    expect(p.reread.some((i) => i.label.startsWith("ghost.ts"))).toBe(true);
    for (let i = 1; i <= 6; i += 1) {
      p = accrueProfile(p, rereadRun("other.ts"), { runId: `g${i}`, ts: `2026-06-0${i + 1}T00:00:00.000Z` });
    }
    expect(p.reread.some((i) => i.label.startsWith("ghost.ts"))).toBe(false); // decayed out
    expect(p.reread.some((i) => i.label.startsWith("other.ts"))).toBe(true);
  });

  it("returns null block for a profile with nothing pinned", () => {
    expect(buildAccumulatedMemory(emptyProfile())).toBeNull();
  });
});
