import { describe, expect, it } from "vitest";

import { createTraceEvent } from "./events.js";
import { buildDeterministicSuggestions, computeEfficiencyReport, type EfficiencyMetric } from "./efficiency.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "opencode", runId: "r", sessionId: "s", kind, payload: payload as never });

const metric = (report: { metrics: EfficiencyMetric[] }, id: string): EfficiencyMetric => {
  const m = report.metrics.find((x) => x.id === id);
  if (!m) throw new Error(`metric ${id} missing`);
  return m;
};

describe("context efficiency report", () => {
  it("flags a file read multiple times as redundant reads with reclaimable tokens", () => {
    const report = computeEfficiencyReport([
      ev(1, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 4000 }),
      ev(2, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 4000 }),
      ev(3, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 4000 })
    ]);
    const m = metric(report, "redundant-reads");
    expect(m.value).toBe(1); // one path re-read
    expect(m.status).not.toBe("good");
    // two extra reads of ~1000 tokens each
    expect(m.reclaimableTokens).toBe(2000);
    expect(m.evidenceEventIds).toHaveLength(2);
  });

  it("computes read amplification from read vs edit sizes", () => {
    const report = computeEfficiencyReport([
      ev(1, "file_read", { source: "tool.after", path: "$PROJECT/big.ts", chars: 80_000 }),
      ev(2, "file_edit", { source: "tool.after", path: "$PROJECT/big.ts", chars: 200 })
    ]);
    const m = metric(report, "read-amplification");
    // 20000 read tokens / 50 edit tokens = 400x -> bad
    expect(m.value).toBeGreaterThan(120);
    expect(m.status).toBe("bad");
  });

  it("flags amplification even when the edit rounds to ~0 tokens", () => {
    const report = computeEfficiencyReport([
      ev(1, "file_read", { source: "tool.after", path: "$PROJECT/huge.ts", chars: 400_000 }),
      ev(2, "file_edit", { source: "tool.after", path: "$PROJECT/huge.ts", chars: 1 })
    ]);
    const m = metric(report, "read-amplification");
    expect(m.status).toBe("bad");
  });

  it("escalates a single file re-read many times to bad by reclaimable magnitude", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      ev(i + 1, "file_read", { source: "tool.after", path: "$PROJECT/x.ts", chars: 8000 })
    );
    const m = metric(computeEfficiencyReport(events), "redundant-reads");
    expect(m.value).toBe(1); // one distinct path
    expect(m.reclaimableTokens).toBe(18_000); // 9 extra reads × 2000
    expect(m.status).toBe("bad");
  });

  it("flags repeated failing commands as retry waste", () => {
    const report = computeEfficiencyReport([
      ev(1, "bash", { source: "tool.after", command: "npm test", exitCode: 1, outputChars: 4000 }),
      ev(2, "bash", { source: "tool.after", command: "npm test", exitCode: 1, outputChars: 4000 }),
      ev(3, "bash", { source: "tool.after", command: "npm test", exitCode: 0, outputChars: 400 })
    ]);
    const m = metric(report, "retry-waste");
    expect(m.value).toBe(2); // two re-runs after the first failed
    expect(m.reclaimableTokens).toBe(2000);
  });

  it("reads real token snapshots for cache-hit and context-pressure", () => {
    const report = computeEfficiencyReport([
      ev(1, "message", { properties: { tokens: { input: 200_000, output: 500, cache: { read: 150_000, write: 1000 } } } })
    ]);
    expect(report.estimated).toBe(false);
    const cache = metric(report, "cache-hit");
    // 150000 / (150000 + 200000) ≈ 43%
    expect(Math.round(cache.value * 100)).toBe(43);
    const pressure = metric(report, "context-pressure");
    expect(pressure.value).toBe(200_000);
    expect(pressure.status).toBe("bad"); // > 180k
  });

  it("marks cache-hit n/a (weight 0) when no cache telemetry and estimates tokens", () => {
    const report = computeEfficiencyReport([
      ev(1, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 4000 }),
      ev(2, "file_edit", { source: "tool.after", path: "$PROJECT/a.ts", chars: 4000 })
    ]);
    expect(report.estimated).toBe(true);
    expect(metric(report, "cache-hit").display).toBe("n/a");
  });

  it("yields a deterministic suggestion for every flagged metric", () => {
    const report = computeEfficiencyReport([
      ev(1, "message", { properties: { tokens: { input: 200_000, output: 100, cache: { read: 5000, write: 100 } } } }),
      ev(2, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 80_000 }),
      ev(3, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 80_000 }),
      ev(4, "file_edit", { source: "tool.after", path: "$PROJECT/a.ts", chars: 100 }),
      ev(5, "bash", { source: "tool.after", command: "npm test", exitCode: 1, outputChars: 8000 }),
      ev(6, "bash", { source: "tool.after", command: "npm test", exitCode: 0, outputChars: 200 })
    ]);
    const flagged = report.metrics.filter((m) => m.status !== "good").map((m) => m.id).sort();
    const suggestions = buildDeterministicSuggestions(report);
    // every flagged metric gets exactly one actionable suggestion
    expect(suggestions.map((s) => s.metricId).sort()).toEqual(flagged);
    expect(suggestions.every((s) => s.action.length > 20 && s.source === "deterministic")).toBe(true);
  });

  it("produces no suggestions for a clean run", () => {
    const report = computeEfficiencyReport([
      ev(1, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 800 }),
      ev(2, "file_edit", { source: "tool.after", path: "$PROJECT/a.ts", chars: 400 })
    ]);
    expect(buildDeterministicSuggestions(report)).toEqual([]);
  });

  it("produces a clean report for an efficient run", () => {
    const report = computeEfficiencyReport([
      ev(1, "file_read", { source: "tool.after", path: "$PROJECT/a.ts", chars: 800 }),
      ev(2, "file_edit", { source: "tool.after", path: "$PROJECT/a.ts", chars: 400 }),
      ev(3, "bash", { source: "tool.after", command: "npm test", exitCode: 0, outputChars: 200 })
    ]);
    expect(report.overallScore).toBeGreaterThan(70);
    expect(report.status).toBe("good");
    expect(report.reclaimableTokens).toBe(0);
  });
});
