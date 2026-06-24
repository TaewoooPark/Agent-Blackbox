import type { TaskArchetype } from "./taskProfile.js";

// Relative baselines — score a run against YOUR usual run of the same kind, not
// just absolute thresholds. "2.3× the tokens of your median research run" is a
// self-calibrating, task-fair signal the global constants can't give. Pure: the
// daemon owns persistence; these transforms are deterministic + testable.

export type RunSummary = {
  runId: string;
  ts: string; // ISO; newest wins on cap
  archetype: TaskArchetype;
  score: number; // overall efficiency
  inputTokens: number; // totalInputTokens (peak proxy)
  project?: string; // project key (dominant-cwd basename) — scopes the comparison
};

export type BaselineComparison = {
  archetype: TaskArchetype;
  sampleSize: number; // prior runs of this archetype compared against (excludes the current run)
  verdict: "better" | "worse" | "typical" | "insufficient";
  scoreDelta: number; // current.score - median (0 when insufficient)
  inputRatio: number | null; // current.inputTokens / median (null if no baseline)
  note: string; // one-line human summary, "" when insufficient
};

export const BASELINE_MAX_HISTORY = 50;
const MIN_SAMPLES = 3; // need at least this many prior runs to compare
const SCORE_BAND = 5; // within ±5 points reads as "typical"

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

/**
 * Insert or replace a run's summary (keyed by runId, so re-recording the same
 * run updates it rather than duplicating), keeping the most recent `cap` by ts.
 */
export function upsertRunSummary(history: RunSummary[], summary: RunSummary, cap = BASELINE_MAX_HISTORY): RunSummary[] {
  const next = history.filter((h) => h.runId !== summary.runId);
  next.push(summary);
  next.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first
  return next.slice(0, cap);
}

/**
 * Compare a run to the baseline of OTHER runs of the same archetype in `history`.
 * Excludes the run itself, so a run never compares to a baseline containing it.
 * Returns an "insufficient" verdict (and empty note) until there are enough
 * prior samples — we never invent a trend from one or two runs.
 */
export function compareToBaseline(current: RunSummary, history: RunSummary[]): BaselineComparison {
  // Same task type, excluding the run itself — and same PROJECT when we know it, so
  // a global daemon doesn't compare your research run here against research runs in
  // five other repos. (No project on the current run → fall back to all projects.)
  const peers = history.filter(
    (h) =>
      h.archetype === current.archetype &&
      h.runId !== current.runId &&
      (current.project === undefined || h.project === current.project)
  );
  if (peers.length < MIN_SAMPLES) {
    return {
      archetype: current.archetype,
      sampleSize: peers.length,
      verdict: "insufficient",
      scoreDelta: 0,
      inputRatio: null,
      note: ""
    };
  }
  const medScore = median(peers.map((p) => p.score));
  const medInput = median(peers.map((p) => p.inputTokens));
  const scoreDelta = current.score - medScore;
  const inputRatio = medInput > 0 ? current.inputTokens / medInput : null;
  const verdict: BaselineComparison["verdict"] =
    scoreDelta > SCORE_BAND ? "better" : scoreDelta < -SCORE_BAND ? "worse" : "typical";

  const parts: string[] = [`score ${current.score} vs your usual ${medScore} for ${current.archetype} (${peers.length} runs)`];
  if (inputRatio !== null && (inputRatio >= 1.3 || inputRatio <= 0.77)) {
    parts.push(`${inputRatio.toFixed(1)}× the tokens`);
  }
  return { archetype: current.archetype, sampleSize: peers.length, verdict, scoreDelta, inputRatio, note: parts.join(" · ") };
}
