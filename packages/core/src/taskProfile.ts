import type { TraceEvent } from "./events.js";

// Task conditioning — infer what KIND of task a run was so the efficiency score
// is judged on a yardstick that fits it. A research/read task SHOULD read widely;
// an ops/bash task lives in command output. Without this, the same absolute
// thresholds penalise a research run for doing its job. Pure + deterministic
// (no LLM, nothing leaves the process) so the daemon can replay it.

export const taskArchetypes = ["research", "debug", "feature", "ops", "edit", "unknown"] as const;
export type TaskArchetype = (typeof taskArchetypes)[number];

export type RunClassification = {
  archetype: TaskArchetype;
  confidence: number; // 0..1, how strongly the signals point here
  signals: string[]; // human-readable reasons, surfaced in the UI/digest
};

export type ArchetypeProfile = {
  // Dimensions that are EXPECTED for this task type — forced to good (no penalty,
  // no flag, no reclaimable), because doing them IS the job (e.g. reading widely on
  // a research run). This lifts the score where the baseline would unfairly ding it.
  expected?: string[];
  // Weight multipliers to EMPHASISE a dimension (>1) so a real problem there matters
  // more for this task type (e.g. retries on a debug run). Only ever use >1: to
  // de-emphasise a dimension, mark it `expected` instead — a <1 weight distorts the
  // weighted average (it can quietly LOWER a score by shrinking a good metric's pull).
  weight?: Record<string, number>;
};

// Per-archetype conditioning. Only archetypes whose healthy profile genuinely
// differs from the baseline carry anything; the rest stay neutral so their scores
// match the unconditioned report exactly.
export const ARCHETYPE_PROFILES: Record<TaskArchetype, ArchetypeProfile> = {
  // Reading widely IS the job — don't judge read efficiency on an edit yardstick.
  research: { expected: ["read-amplification", "exploration-waste", "big-file-read", "large-injections"] },
  // Edit↔test loops are expected; weigh rework/retries/yield harder.
  debug: { weight: { "retry-waste": 1.5, "edit-thrash": 1.5, "yield-density": 1.5 } },
  // Bash-dominated: command output + reads come with the territory; retries matter.
  ops: { expected: ["large-injections", "read-amplification", "redundant-reads"], weight: { "retry-waste": 1.3 } },
  feature: {},
  edit: {},
  unknown: {}
};

const TEST_BUILD = /\b(test|jest|vitest|pytest|mocha|build|tsc|lint|eslint|cargo|gradle|make|go\s+test)\b/;
const SEARCH_VERBS = new Set(["grep", "rg", "ag", "ack", "find", "fd"]);
const CHARS_PER_TOKEN = 4;

const str = (e: TraceEvent, k: string): string | undefined =>
  typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined;
const num = (e: TraceEvent, k: string): number | undefined =>
  typeof e.payload[k] === "number" && Number.isFinite(e.payload[k] as number) ? (e.payload[k] as number) : undefined;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Classify a run into a task archetype from its observed actions. Conservative:
 * anything ambiguous falls back to a neutral archetype (edit/unknown) whose
 * weights match the unconditioned baseline, so conditioning never silently
 * changes a score it isn't confident about.
 */
export function classifyRun(events: TraceEvent[]): RunClassification {
  let reads = 0;
  let bash = 0;
  let failBash = 0;
  let testBash = 0;
  let creates = 0;
  let edits = 0;
  let readTokens = 0;
  let editTokens = 0;
  const distinctReads = new Set<string>();
  const distinctEdits = new Set<string>();

  for (const e of events) {
    switch (e.kind) {
      case "file_read": {
        reads += 1;
        const p = str(e, "path");
        if (p) distinctReads.add(p);
        readTokens += Math.max(0, Math.round((num(e, "chars") ?? 0) / CHARS_PER_TOKEN));
        break;
      }
      case "file_edit": {
        edits += 1;
        const p = str(e, "path");
        if (p) distinctEdits.add(p);
        editTokens += Math.max(0, Math.round((num(e, "chars") ?? 0) / CHARS_PER_TOKEN));
        break;
      }
      case "file_created":
        creates += 1;
        break;
      case "bash": {
        bash += 1;
        const c = (str(e, "command") ?? "").trim();
        const code = num(e, "exitCode");
        if (code !== undefined && code !== 0) failBash += 1;
        if (TEST_BUILD.test(c)) testBash += 1;
        break;
      }
      default:
        break;
    }
  }

  const changed = distinctEdits.size + creates;

  // research — no real edits but real reading, or reads that dwarf the edits.
  if (changed === 0 && distinctReads.size >= 2) {
    return { archetype: "research", confidence: clamp01(distinctReads.size / 5), signals: ["reads, no file changes"] };
  }
  if (distinctReads.size >= 3 && changed <= 1 && editTokens < readTokens * 0.05) {
    return { archetype: "research", confidence: 0.6, signals: ["reads dominate the edits"] };
  }
  // ops — bash-dominated with few file changes.
  if (bash >= 5 && bash > reads + edits && changed <= 2) {
    return { archetype: "ops", confidence: clamp01(bash / 12), signals: ["bash-dominated, few file changes"] };
  }
  // debug — editing plus test/build runs (especially with failures).
  if (changed >= 1 && testBash >= 1 && (failBash >= 1 || edits > distinctEdits.size)) {
    return {
      archetype: "debug",
      confidence: failBash >= 1 ? 0.7 : 0.5,
      signals: [`edit↔test cycles${failBash >= 1 ? " with failures" : ""}`]
    };
  }
  // feature — several new files.
  if (creates >= 2) {
    return { archetype: "feature", confidence: clamp01(creates / 4), signals: ["new files created"] };
  }
  // edit — any real change, otherwise unknown.
  if (changed >= 1) {
    return { archetype: "edit", confidence: 0.5, signals: ["editing existing files"] };
  }
  return { archetype: "unknown", confidence: 0.2, signals: ["sparse activity"] };
}
