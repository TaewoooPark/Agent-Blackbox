import { describe, expect, it } from "vitest";

import { computeEffectiveness } from "./effectiveness.js";
import { createTraceEvent } from "./events.js";
import type { PromiseCheck } from "./audit.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "claude-code", runId: "r", sessionId: "s", kind, payload: payload as never });

describe("computeEffectiveness", () => {
  it("rates a run that edited, passed tests, and committed as succeeded", () => {
    const r = computeEffectiveness([
      ev(1, "file_edit", { path: "a.ts", chars: 800 }),
      ev(2, "bash", { command: "npm test", exitCode: 0, outputChars: 200 }),
      ev(3, "git_commit", { command: "git commit", exitCode: 0, outputChars: 50 })
    ]);
    expect(r.status).toBe("good");
    expect(r.label).toBe("succeeded");
    expect(r.confidence).toBe("high");
  });

  it("rates an efficient-looking run that ended on a failing test as rough", () => {
    const r = computeEffectiveness([
      ev(1, "file_edit", { path: "a.ts", chars: 200 }),
      ev(2, "bash", { command: "npm test", exitCode: 1, outputChars: 500 }),
      ev(3, "session_error", { message: "boom" }),
      ev(4, "host_event", { event: "api_error", level: "error" })
    ]);
    expect(r.status).toBe("bad");
    expect(r.label).toBe("rough");
    expect(r.signals.some((s) => s.id === "verify" && s.tone === "bad")).toBe(true);
  });

  it("does not claim success or failure when there's almost no signal", () => {
    const r = computeEffectiveness([ev(1, "message", { role: "assistant" })]);
    expect(r.confidence).toBe("low");
    expect(r.label).toBe("unclear");
    expect(r.score).toBeGreaterThan(45); // pulled back toward neutral, not asserting failure
    expect(r.score).toBeLessThan(85);
  });

  it("penalises a run whose claims the trace contradicts", () => {
    const checks: PromiseCheck[] = [
      { claim: "tests pass", status: "contradicted", severity: "risk", evidenceEventIds: [] }
    ];
    const withContradiction = computeEffectiveness([ev(1, "file_edit", { path: "a.ts", chars: 400 })], checks);
    const clean = computeEffectiveness([ev(1, "file_edit", { path: "a.ts", chars: 400 })], []);
    expect(withContradiction.score).toBeLessThan(clean.score);
    expect(withContradiction.signals.some((s) => s.id === "contradicted")).toBe(true);
  });

  it("separates the two axes: a wasteful run can still be effective", () => {
    // Lots of redundant reads (efficiency would be low) but it shipped + verified.
    const r = computeEffectiveness([
      ev(1, "file_read", { path: "a.ts", chars: 200_000 }),
      ev(2, "file_read", { path: "a.ts", chars: 200_000 }),
      ev(3, "file_edit", { path: "a.ts", chars: 4000 }),
      ev(4, "bash", { command: "npm run build", exitCode: 0, outputChars: 100 }),
      ev(5, "git_commit", { command: "git commit -m x", exitCode: 0, outputChars: 40 })
    ]);
    expect(r.status).toBe("good");
  });
});
