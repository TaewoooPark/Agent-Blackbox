import type { PromiseCheck } from "./audit.js";
import type { TraceEvent } from "./events.js";

// The second axis. Efficiency asks "did the run use context economically?" — a run
// can ace that and still have FAILED (looped, errored, left a broken build). This
// heuristic asks "did the task actually land?" from observable outcome + verification
// + failure signals, so a wasteful-but-successful run and an efficient-but-failed run
// read differently. Deliberately a heuristic with a confidence flag: when there's
// little signal it pulls back to neutral rather than claiming success or failure.

export type EffectivenessStatus = "good" | "warn" | "bad";
export type EffectivenessConfidence = "low" | "medium" | "high";
export type EffectivenessSignal = { id: string; label: string; tone: "good" | "bad" | "neutral" };

export type EffectivenessReport = {
  score: number; // 0-100, higher = more likely the task actually succeeded
  status: EffectivenessStatus;
  label: string; // "succeeded" | "mixed" | "rough" | "unclear"
  confidence: EffectivenessConfidence;
  signals: EffectivenessSignal[];
};

const TEST_BUILD = /\b(test|jest|vitest|pytest|mocha|build|tsc|lint|eslint|cargo|gradle|make|go\s+test)\b/;
const NEUTRAL = 72;

const str = (e: TraceEvent, k: string): string | undefined =>
  typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined;
const num = (e: TraceEvent, k: string): number | undefined =>
  typeof e.payload[k] === "number" && Number.isFinite(e.payload[k] as number) ? (e.payload[k] as number) : undefined;

export function computeEffectiveness(events: TraceEvent[], checks: PromiseCheck[] = []): EffectivenessReport {
  let edits = 0;
  let creates = 0;
  let commits = 0;
  let pushes = 0;
  let hardErrors = 0; // session_error — a real run failure
  let softErrors = 0; // host_event api_error — usually transient + auto-retried, weak signal
  let cmds = 0;
  let failCmds = 0;
  let lastVerify: "passed" | "failed" | undefined;

  for (const e of events) {
    switch (e.kind) {
      case "file_edit":
        edits += 1;
        break;
      case "file_created":
        creates += 1;
        break;
      case "git_commit": {
        const code = num(e, "exitCode");
        if (code === undefined || code === 0) commits += 1; // only a clean commit counts
        break;
      }
      case "git_push":
        pushes += 1;
        break;
      case "session_error":
        hardErrors += 1;
        break;
      case "host_event":
        if (str(e, "level") === "error") softErrors += 1;
        break;
      case "bash": {
        const code = num(e, "exitCode");
        const c = str(e, "command") ?? "";
        if (code !== undefined) {
          cmds += 1;
          if (code !== 0) failCmds += 1;
          if (TEST_BUILD.test(c)) lastVerify = code === 0 ? "passed" : "failed";
        }
        break;
      }
      default:
        break;
    }
  }

  const outcomes = edits + creates + commits;
  const contradicted = checks.filter((c) => c.status === "contradicted").length;
  const riskyUnverified = checks.filter(
    (c) => c.status === "unverified" && (c.severity === "risk" || c.severity === "warning")
  ).length;

  const signals: EffectivenessSignal[] = [];
  let score = NEUTRAL;
  let evidence = 0; // how many independent signals fired — drives confidence

  if (outcomes > 0) {
    score += 8;
    evidence += 1;
    signals.push({ id: "output", label: `${outcomes} concrete change${outcomes === 1 ? "" : "s"}`, tone: "good" });
  } else {
    score -= 8;
    signals.push({ id: "output", label: "no file changes or commits", tone: "bad" });
  }

  if (lastVerify === "passed") {
    score += 15;
    evidence += 1;
    signals.push({ id: "verify", label: "tests/build passed", tone: "good" });
  } else if (lastVerify === "failed") {
    score -= 25;
    evidence += 1;
    signals.push({ id: "verify", label: "ended on a failing test/build", tone: "bad" });
  }

  if (commits > 0) {
    score += 10;
    evidence += 1;
    signals.push({ id: "commit", label: `${commits} commit${commits === 1 ? "" : "s"}${pushes > 0 ? " + push" : ""}`, tone: "good" });
  }

  if (hardErrors > 0) {
    score -= Math.min(30, hardErrors * 15);
    evidence += 1;
    signals.push({ id: "errors", label: `${hardErrors} session error${hardErrors === 1 ? "" : "s"}`, tone: "bad" });
  }
  if (softErrors > 0) {
    // Transient API errors are mostly retried away — nudge, don't dominate, and
    // don't treat them as strong evidence either way.
    score -= Math.min(8, softErrors);
    signals.push({ id: "api-errors", label: `${softErrors} transient API error${softErrors === 1 ? "" : "s"}`, tone: "neutral" });
  }

  if (cmds >= 3 && failCmds / cmds > 0.4) {
    score -= 15;
    evidence += 1;
    signals.push({ id: "failrate", label: `${failCmds}/${cmds} commands failed`, tone: "bad" });
  }

  if (contradicted > 0) {
    score -= Math.min(20, contradicted * 8);
    evidence += 1;
    signals.push({ id: "contradicted", label: `${contradicted} claim${contradicted === 1 ? "" : "s"} contradicted by the trace`, tone: "bad" });
  } else if (riskyUnverified > 0) {
    score -= Math.min(10, riskyUnverified * 4);
    signals.push({ id: "unverified", label: `${riskyUnverified} unverified claim${riskyUnverified === 1 ? "" : "s"}`, tone: "neutral" });
  }

  const confidence: EffectivenessConfidence = evidence >= 3 ? "high" : evidence >= 1 ? "medium" : "low";
  // Too little signal to judge — pull back toward neutral so we don't assert success
  // or failure on a run we can't see the outcome of.
  if (confidence === "low") score = (score + NEUTRAL) / 2;

  score = Math.max(0, Math.min(100, Math.round(score)));
  const status: EffectivenessStatus = score >= 70 ? "good" : score >= 45 ? "warn" : "bad";
  // "succeeded" is a strong claim — reserve it for high confidence; a good score on
  // medium evidence reads "likely ok", and low confidence never asserts an outcome.
  const label =
    confidence === "low"
      ? "unclear"
      : status === "good"
        ? confidence === "high"
          ? "succeeded"
          : "likely ok"
        : status === "warn"
          ? "mixed"
          : "rough";
  return { score, status, label, confidence, signals };
}
