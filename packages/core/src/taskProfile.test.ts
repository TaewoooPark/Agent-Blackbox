import { describe, expect, it } from "vitest";

import { createTraceEvent } from "./events.js";
import { computeEfficiencyReport } from "./efficiency.js";
import { classifyRun } from "./taskProfile.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "claude-code", runId: "r", sessionId: "s", kind, payload: payload as never });

describe("classifyRun", () => {
  it("calls a reads-only run research", () => {
    const c = classifyRun([
      ev(1, "file_read", { path: "a.ts", chars: 4000 }),
      ev(2, "file_read", { path: "b.ts", chars: 4000 }),
      ev(3, "file_read", { path: "c.ts", chars: 4000 })
    ]);
    expect(c.archetype).toBe("research");
  });

  it("calls reads that dwarf a tiny edit research", () => {
    const c = classifyRun([
      ev(1, "file_read", { path: "a.ts", chars: 200_000 }),
      ev(2, "file_read", { path: "b.ts", chars: 200_000 }),
      ev(3, "file_read", { path: "c.ts", chars: 200_000 }),
      ev(4, "file_edit", { path: "a.ts", chars: 80 })
    ]);
    expect(c.archetype).toBe("research");
  });

  it("calls edit + failing tests debug", () => {
    const c = classifyRun([
      ev(1, "file_edit", { path: "a.ts", chars: 4000 }),
      ev(2, "bash", { command: "npm test", exitCode: 1, outputChars: 500 }),
      ev(3, "file_edit", { path: "a.ts", chars: 4000 }),
      ev(4, "bash", { command: "npm test", exitCode: 0, outputChars: 200 })
    ]);
    expect(c.archetype).toBe("debug");
  });

  it("calls a bash-dominated run ops", () => {
    const c = classifyRun([
      ev(1, "bash", { command: "docker ps", exitCode: 0, outputChars: 500 }),
      ev(2, "bash", { command: "kubectl get pods", exitCode: 0, outputChars: 500 }),
      ev(3, "bash", { command: "df -h", exitCode: 0, outputChars: 200 }),
      ev(4, "bash", { command: "ls -la", exitCode: 0, outputChars: 200 }),
      ev(5, "bash", { command: "cat log", exitCode: 0, outputChars: 200 }),
      ev(6, "bash", { command: "tail log", exitCode: 0, outputChars: 200 })
    ]);
    expect(c.archetype).toBe("ops");
  });

  it("calls a many-creates run feature, and a plain edit edit", () => {
    expect(
      classifyRun([
        ev(1, "file_created", { path: "a.ts", chars: 400 }),
        ev(2, "file_created", { path: "b.ts", chars: 400 }),
        ev(3, "file_created", { path: "c.ts", chars: 400 })
      ]).archetype
    ).toBe("feature");
    expect(classifyRun([ev(1, "file_edit", { path: "a.ts", chars: 400 })]).archetype).toBe("edit");
    expect(classifyRun([]).archetype).toBe("unknown");
  });
});

describe("archetype conditioning of the efficiency score", () => {
  // A research run that re-reads a big file: under the neutral 'edit' yardstick the
  // read metrics flag and drag the score; under 'research' they're demoted to good.
  const researchish = [
    ev(1, "file_read", { source: "tool.after", path: "$P/a.ts", chars: 200_000 }),
    ev(2, "file_read", { source: "tool.after", path: "$P/b.ts", chars: 200_000 }),
    ev(3, "file_read", { source: "tool.after", path: "$P/c.ts", chars: 200_000 }),
    ev(4, "file_edit", { source: "tool.after", path: "$P/a.ts", chars: 80 })
  ];

  it("demotes read-amplification/exploration-waste for a research task", () => {
    const asEdit = computeEfficiencyReport(researchish, { archetype: "edit" });
    const asResearch = computeEfficiencyReport(researchish, { archetype: "research" });
    // Neutral yardstick flags read-heavy metrics…
    expect(asEdit.metrics.find((m) => m.id === "read-amplification")?.status).not.toBe("good");
    // …research yardstick treats them as expected.
    expect(asResearch.metrics.find((m) => m.id === "read-amplification")?.status).toBe("good");
    expect(asResearch.metrics.find((m) => m.id === "exploration-waste")?.status).toBe("good");
    // So the research score is at least as high, and reclaimable doesn't count demoted dims.
    expect(asResearch.overallScore).toBeGreaterThanOrEqual(asEdit.overallScore);
  });

  it("auto-classifies (no override) and exposes the archetype on the report", () => {
    const report = computeEfficiencyReport(researchish);
    expect(report.archetype).toBe("research");
    expect(report.archetypeSignals.length).toBeGreaterThan(0);
  });

  it("leaves neutral archetypes byte-identical to the unconditioned score", () => {
    const events = [
      ev(1, "file_read", { source: "tool.after", path: "$P/a.ts", chars: 800 }),
      ev(2, "file_edit", { source: "tool.after", path: "$P/a.ts", chars: 400 }),
      ev(3, "bash", { source: "tool.after", command: "ls", exitCode: 0, outputChars: 100 })
    ];
    expect(computeEfficiencyReport(events, { archetype: "edit" }).overallScore).toBe(
      computeEfficiencyReport(events, { archetype: "unknown" }).overallScore
    );
  });
});
