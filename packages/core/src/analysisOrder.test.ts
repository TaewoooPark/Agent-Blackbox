import { describe, expect, it } from "vitest";
import {
  buildCausalTimeline,
  computeEffectiveness,
  computeEfficiencyReport,
  createTraceEvent,
  evaluatePromiseChecks,
  firstUserPrompt,
  generateHandoffMarkdown,
  materializeWorkflowGraph,
  orderEventsForAnalysis,
  type TraceEvent,
  type TraceEventInput
} from "./index.js";

const ev = (seq: number, kind: TraceEventInput["kind"], payload: NonNullable<TraceEventInput["payload"]>, runId = "run") =>
  createTraceEvent(seq, { host: "motifcode", runId, sessionId: runId, kind, payload });

describe("Motifcode analysis after historical backfill", () => {
  const root = ev(2, "message", { role: "user", text: "Fix the failing parser test." });
  const failed = ev(10, "bash", { command: "npm test", success: false, outputChars: 400 });
  const olderUsage = ev(11, "message", { tokens: { input: 1000, output: 100, cache: { read: 0 } } });
  const child = { ...ev(12, "message", { role: "user", text: "Review the parser change." }), agentRole: "subagent" as const };
  const passed = ev(20, "bash", { command: "npm test", success: true, outputChars: 40 });
  const latestUsage = ev(21, "message", { tokens: { input: 2000, output: 100, cache: { read: 1800 } } });
  const chronological = [root, failed, olderUsage, child, passed, latestUsage];
  const liveThenBackfill = [child, passed, latestUsage, root, failed, olderUsage];

  it("uses the actual latest usage and verification, and the initial root objective", () => {
    const originalOrder = [...liveThenBackfill];
    const efficiency = computeEfficiencyReport(liveThenBackfill);
    expect(efficiency).toEqual(computeEfficiencyReport(chronological));
    expect(efficiency.metrics.find((metric) => metric.id === "cache-hit")?.value).toBe(0.9);
    const effectiveness = computeEffectiveness(liveThenBackfill);
    expect(effectiveness).toEqual(computeEffectiveness(chronological));
    expect(effectiveness.signals).toContainEqual({ id: "verify", label: "tests/build passed", tone: "good" });
    expect(firstUserPrompt(liveThenBackfill)).toBe("Fix the failing parser test.");
    expect(generateHandoffMarkdown(materializeWorkflowGraph(liveThenBackfill), [], liveThenBackfill))
      .toContain("## Current Objective\nFix the failing parser test.");
    expect(buildCausalTimeline(liveThenBackfill)).toEqual(buildCausalTimeline(chronological));
    expect(liveThenBackfill).toEqual(originalOrder);
  });

  it("restores claim and evidence order without changing legacy host analysis", () => {
    const earlierClaim = ev(14, "message", { role: "assistant", text: "Ran tests before the fix." });
    const laterClaim = ev(22, "message", { role: "assistant", text: "Ran tests after the fix." });
    expect(evaluatePromiseChecks([passed, laterClaim, failed, earlierClaim]))
      .toEqual(evaluatePromiseChecks([failed, earlierClaim, passed, laterClaim]));

    const legacy: TraceEvent[] = liveThenBackfill.map((event) => ({ ...event, host: "opencode" }));
    expect(orderEventsForAnalysis(legacy)).toBe(legacy);
    expect(firstUserPrompt(legacy)).toBe("Review the parser change.");
    expect(computeEffectiveness(legacy).signals).toContainEqual({ id: "verify", label: "ended on a failing test/build", tone: "bad" });
    expect(computeEfficiencyReport(legacy).metrics.find((metric) => metric.id === "cache-hit")?.value).toBe(0);
  });

  it("sorts only within each Motifcode run's slots, leaving other hosts in place", () => {
    const otherLatest = ev(9, "host_event", {}, "other");
    const otherEarlier = ev(1, "host_event", {}, "other");
    const legacy = { ...ev(100, "host_event", {}), host: "codex" as const };
    const input = [passed, legacy, otherLatest, failed, otherEarlier];
    const originalOrder = [...input];
    const ordered = orderEventsForAnalysis(input);
    expect(ordered).toEqual([failed, legacy, otherEarlier, passed, otherLatest]);
    expect(input).toEqual(originalOrder);
    expect(orderEventsForAnalysis(ordered)).toBe(ordered);
  });
});
