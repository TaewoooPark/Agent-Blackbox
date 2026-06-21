import type { TraceEvent } from "./events.js";

// Context Efficiency — derive how economically a run used its context window from
// observed events (sizes captured by the adapter + token snapshots), never from
// the agent's self-report. Pure and deterministic so the daemon can replay it at
// any seq and the dashboard can render it live.

export type EfficiencyStatus = "good" | "warn" | "bad";

export type EfficiencyMetric = {
  id: string;
  label: string;
  value: number;
  unit: "tokens" | "%" | "x" | "count" | "ratio";
  display: string;
  score: number; // 0–100, higher = more efficient
  status: EfficiencyStatus;
  detail: string;
  evidenceEventIds: string[];
  reclaimableTokens?: number;
  // Coarse, low-sensitivity labels of the specific offenders (file basenames,
  // command verbs — never full paths or command lines) so advice can name what
  // to fix, e.g. ["config.json ×5"], ["grep ~12k"]. Top few by impact.
  offenders?: string[];
};

export type EfficiencyReport = {
  overallScore: number;
  status: EfficiencyStatus;
  headline: string;
  totalInputTokens: number;
  reclaimableTokens: number;
  estimated: boolean; // true when token figures are size-estimated (no real snapshots)
  metrics: EfficiencyMetric[];
};

export type Suggestion = {
  metricId: string;
  severity: "warn" | "bad";
  title: string;
  action: string;
  source: "deterministic" | "llm";
};

// Rule-based optimization advice for every flagged metric. Always available with
// no model — the dependable floor under the optional LLM-routed suggestions.
export function buildDeterministicSuggestions(report: EfficiencyReport): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const metric of report.metrics) {
    if (metric.status === "good") continue;
    const action = deterministicActionFor(metric);
    if (!action) continue;
    suggestions.push({
      metricId: metric.id,
      severity: metric.status,
      title: metric.label,
      action,
      source: "deterministic"
    });
  }
  return suggestions;
}

function deterministicActionFor(metric: EfficiencyMetric): string | undefined {
  const reclaim = metric.reclaimableTokens ? ` (~${formatTokens(metric.reclaimableTokens)} reclaimable)` : "";
  const worst = metric.offenders && metric.offenders.length > 0 ? metric.offenders.join(", ") : "";
  switch (metric.id) {
    case "context-pressure":
      return `Peak input hit ${metric.display}. Compact: summarise resolved turns into a short note of decisions + open bugs and start a fresh window, clear raw tool outputs you've already acted on, and push deep exploration into a sub-agent that returns only a ~1-2k-token summary.`;
    case "cache-hit":
      return `Only ${metric.display} was cache-served, and cached tokens are ~10× cheaper. Keep the prompt prefix byte-stable (no timestamps or per-run data in the system prompt), append new turns instead of editing old ones, and mask unused tools rather than adding/removing them — any change voids the cache from that point on.`;
    case "redundant-reads":
      return `${worst ? `${worst} were re-read` : "Files were re-read"}${reclaim}. Read each file once and keep it in working memory or a notes file; after an edit, re-read only the changed line range, not the whole file.`;
    case "read-amplification":
      return `Read ${metric.display} more text than was edited${worst ? ` (${worst} dominated)` : ""}. Locate with grep/symbol search first, then read only the relevant line range; load a repo map instead of whole files up front.`;
    case "large-injections":
      return `A single output added ${metric.display}${worst ? ` (${worst})` : ""}. Scope it — narrow paths, add a max-count/head limit, or pipe through a summary — or have a sub-agent absorb it and return just the distilled result.`;
    case "retry-waste":
      return `${worst ? `${worst} was re-run after failing` : "Failing commands were re-run"}${reclaim}. Read the first failure's stderr and fix the root cause before retrying once; keep the failed attempt in context so the model doesn't repeat it.`;
    case "yield-density":
      return `A lot of context produced few concrete changes (${metric.display}). Split into smaller verifiable steps, recite the current goal/todo each step to keep it in recent tokens (models under-use the middle of long contexts), and offload exploration to a sub-agent.`;
    case "tool-overhead":
      return `Many tool calls per outcome (${metric.display}). Batch related edits into one change, drop exploratory calls that don't lead to an edit, and trim to a minimal non-overlapping tool set.`;
    default:
      return metric.detail;
  }
}

// ~4 chars per token is the usual rough rule; good enough for relative signals.
const CHARS_PER_TOKEN = 4;
const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

// Coarse, low-sensitivity labels for offender lists (basename, command verb) —
// enough to make advice concrete without leaking full paths or command lines.
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const commandVerb = (command: string): string => command.trim().split(/\s+/)[0] || command;

type TokenSnapshot = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export function computeEfficiencyReport(events: TraceEvent[]): EfficiencyReport {
  // --- token snapshots -------------------------------------------------------
  let finalSnapshot: TokenSnapshot | undefined;
  let peakInput = 0;
  let hasRealTokens = false;
  for (const event of events) {
    const snap = readTokenSnapshot(event);
    if (!snap) continue;
    hasRealTokens = true;
    finalSnapshot = snap;
    peakInput = Math.max(peakInput, snap.input);
  }

  // --- size aggregates from the events --------------------------------------
  const reads: { path: string; tokens: number; id: string }[] = [];
  const edits: { path: string; tokens: number; id: string }[] = [];
  const injections: { label: string; tokens: number; id: string }[] = [];
  const bashRuns: { command: string; exitCode: number | undefined; tokens: number; id: string }[] = [];

  for (const event of events) {
    if (event.kind === "file_read") {
      const chars = numberAt(event, "chars");
      if (chars) reads.push({ path: stringAt(event, "path") ?? event.id, tokens: estimateTokens(chars), id: event.id });
    } else if (event.kind === "file_edit" || event.kind === "file_created") {
      const chars = numberAt(event, "chars");
      if (chars) edits.push({ path: stringAt(event, "path") ?? event.id, tokens: estimateTokens(chars), id: event.id });
    } else if (event.kind === "bash") {
      const chars = numberAt(event, "outputChars") ?? 0;
      const tokens = estimateTokens(chars);
      bashRuns.push({ command: stringAt(event, "command") ?? "", exitCode: numberAt(event, "exitCode"), tokens, id: event.id });
      if (tokens > 0) injections.push({ label: stringAt(event, "command") ?? "command", tokens, id: event.id });
    } else if (event.kind === "tool_result") {
      const chars = numberAt(event, "outputChars");
      if (chars) {
        const label = stringAt(event, "skill") ?? stringAt(event, "tool") ?? "tool";
        injections.push({ label, tokens: estimateTokens(chars), id: event.id });
      }
    }
  }

  const totalReadTokens = reads.reduce((sum, r) => sum + r.tokens, 0);
  const totalEditTokens = edits.reduce((sum, e) => sum + e.tokens, 0);
  const editedPaths = new Set(edits.map((e) => e.path));
  const okCommands = bashRuns.filter((b) => b.exitCode === 0).length;

  // Estimated input = everything pulled into context: reads + edits/creates + tool/bash output.
  // Edits were previously omitted, understating edit-heavy runs' context use and so inflating
  // their yield-density. Sum the already-computed token fields directly.
  const injectionTokens = injections.reduce((s, i) => s + i.tokens, 0);
  const totalInputTokens = hasRealTokens ? finalSnapshot!.input : totalReadTokens + totalEditTokens + injectionTokens;
  const peak = hasRealTokens ? peakInput : totalInputTokens;

  const metrics: { metric: EfficiencyMetric; weight: number }[] = [];

  // --- 1. context pressure (peak input tokens) ------------------------------
  {
    const { score, status } = lowerIsBetter(peak, 100_000, 180_000);
    metrics.push({
      weight: 1.5,
      metric: {
        id: "context-pressure",
        label: "Context pressure",
        value: peak,
        unit: "tokens",
        display: formatTokens(peak),
        score,
        status,
        detail:
          status === "good"
            ? "The context window stayed comfortably sized."
            : hasRealTokens
              ? `Peak input reached ${formatTokens(peak)} — large prompts cost latency and money on every turn.`
              : // No real token telemetry: this is total input pulled in over the run (we can't
                // measure peak window occupancy), so don't claim a measured peak.
                `About ${formatTokens(peak)} of input flowed through the context — large prompts cost latency and money on every turn.`,
        evidenceEventIds: []
      }
    });
  }

  // --- 2. cache hit ratio ----------------------------------------------------
  {
    const cacheRead = finalSnapshot?.cacheRead ?? 0;
    const fresh = finalSnapshot?.input ?? 0;
    const denom = cacheRead + fresh;
    const hasCacheTelemetry = hasRealTokens && (cacheRead > 0 || (finalSnapshot?.cacheWrite ?? 0) > 0);
    const ratio = denom > 0 ? cacheRead / denom : 0;
    if (hasCacheTelemetry) {
      const { score, status } = higherIsBetter(ratio, 0.6, 0.3);
      metrics.push({
        weight: 1,
        metric: {
          id: "cache-hit",
          label: "Cache hit ratio",
          value: ratio,
          unit: "%",
          display: `${Math.round(ratio * 100)}%`,
          score,
          status,
          detail:
            status === "good"
              ? "Most of the prompt was served from cache."
              : "Low prompt-cache reuse — stabilise the prompt prefix so more context is cached.",
          evidenceEventIds: []
        }
      });
    } else {
      metrics.push({
        weight: 0,
        metric: {
          id: "cache-hit",
          label: "Cache hit ratio",
          value: 0,
          unit: "%",
          display: "n/a",
          score: 100,
          status: "good",
          detail: "This model reported no cache telemetry.",
          evidenceEventIds: []
        }
      });
    }
  }

  // --- 3. redundant re-reads -------------------------------------------------
  {
    const byPath = new Map<string, { tokens: number; id: string }[]>();
    for (const r of reads) {
      const list = byPath.get(r.path) ?? [];
      list.push({ tokens: r.tokens, id: r.id });
      byPath.set(r.path, list);
    }
    let reclaimable = 0;
    const evidence: string[] = [];
    let reReadPaths = 0;
    const offenders: { label: string; reclaim: number }[] = [];
    for (const [path, list] of byPath.entries()) {
      if (list.length > 1) {
        reReadPaths += 1;
        let extraTokens = 0;
        for (const extra of list.slice(1)) {
          reclaimable += extra.tokens;
          extraTokens += extra.tokens;
          evidence.push(extra.id);
        }
        offenders.push({ label: `${baseName(path)} ×${list.length}`, reclaim: extraTokens });
      }
    }
    const reReadOffenders = offenders
      .sort((a, b) => b.reclaim - a.reclaim)
      .slice(0, 3)
      .map((o) => o.label);
    let { score, status } = lowerIsBetter(reReadPaths, 0, 2);
    // Re-reading one file many times can reclaim as much as several files would —
    // escalate by magnitude, not just by the count of distinct files.
    if (reclaimable >= 10_000 && status !== "bad") {
      status = "bad";
      score = Math.min(score, 30);
    }
    metrics.push({
      weight: 2,
      metric: {
        id: "redundant-reads",
        label: "Redundant re-reads",
        value: reReadPaths,
        unit: "count",
        display: reReadPaths === 0 ? "none" : `${reReadPaths} ${reReadPaths === 1 ? "file" : "files"}`,
        score,
        status,
        detail:
          reReadPaths === 0
            ? "No file was read more than once."
            : `${reReadPaths} file(s) were read again — about ${formatTokens(reclaimable)} of context was reloaded.`,
        evidenceEventIds: evidence,
        reclaimableTokens: reclaimable,
        ...(reReadOffenders.length > 0 ? { offenders: reReadOffenders } : {})
      }
    });
  }

  // --- 4. read amplification (read tokens ÷ edited tokens) -------------------
  // Fire whenever edits exist (even a one-line edit) — clamp the denominator so a
  // huge read against a tiny edit, the worst case, still surfaces.
  if (edits.length > 0 && totalReadTokens > 0) {
    const ratio = totalReadTokens / Math.max(totalEditTokens, 1);
    const { score, status } = lowerIsBetter(ratio, 40, 120);
    const readByPath = new Map<string, number>();
    for (const r of reads) readByPath.set(r.path, (readByPath.get(r.path) ?? 0) + r.tokens);
    const topReaders = [...readByPath.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([path, tokens]) => `${baseName(path)} ~${formatTokens(tokens)}`);
    metrics.push({
      weight: 2,
      metric: {
        id: "read-amplification",
        label: "Read amplification",
        value: ratio,
        unit: "x",
        display: `${ratio.toFixed(ratio >= 10 ? 0 : 1)}×`,
        score,
        status,
        detail:
          status === "good"
            ? "Reads were roughly proportional to the edits made."
            : `Read ${formatTokens(totalReadTokens)} to write ${formatTokens(totalEditTokens)} — pull in less, use ranged reads.`,
        evidenceEventIds: reads.slice(0, 5).map((r) => r.id),
        ...(status !== "good" && topReaders.length > 0 ? { offenders: topReaders } : {})
      }
    });
  }

  // --- 5. large injections (single tool output dumped into context) ---------
  {
    const sorted = [...injections].sort((a, b) => b.tokens - a.tokens);
    const biggest = sorted[0]?.tokens ?? 0;
    const over5k = sorted.filter((i) => i.tokens >= 5_000);
    const { score, status } = lowerIsBetter(biggest, 5_000, 15_000);
    const injectionOffenders = over5k.slice(0, 3).map((i) => `${commandVerb(i.label)} ~${formatTokens(i.tokens)}`);
    metrics.push({
      weight: 1.5,
      metric: {
        id: "large-injections",
        label: "Large context injections",
        value: biggest,
        unit: "tokens",
        display: biggest >= 5_000 ? formatTokens(biggest) : "none",
        score,
        status,
        detail:
          over5k.length === 0
            ? "No single tool output flooded the context."
            : `${over5k.length} output(s) added 5k+ tokens (largest ${formatTokens(biggest)}) — scope greps/reads or summarise.`,
        evidenceEventIds: over5k.map((i) => i.id),
        ...(injectionOffenders.length > 0 ? { offenders: injectionOffenders } : {})
      }
    });
  }

  // --- 6. retry waste (identical command run more than once) ----------------
  {
    const byCommand = new Map<string, { exitCode: number | undefined; tokens: number; id: string }[]>();
    for (const b of bashRuns) {
      if (!b.command) continue;
      const list = byCommand.get(b.command) ?? [];
      list.push({ exitCode: b.exitCode, tokens: b.tokens, id: b.id });
      byCommand.set(b.command, list);
    }
    let wasted = 0;
    let retries = 0;
    const evidence: string[] = [];
    const offenders: { label: string; runs: number }[] = [];
    for (const [command, list] of byCommand.entries()) {
      if (list.length <= 1) continue;
      retries += list.length - 1;
      // Every failed attempt of a command that had to be repeated is wasted context.
      // An unknown exit code (the adapter didn't capture one) is NOT a failure —
      // `undefined !== 0` would otherwise charge every uncaptured re-run as waste.
      for (const attempt of list) {
        if (attempt.exitCode !== undefined && attempt.exitCode !== 0) {
          wasted += attempt.tokens;
          evidence.push(attempt.id);
        }
      }
      offenders.push({ label: `${commandVerb(command)} ×${list.length}`, runs: list.length });
    }
    const retryOffenders = offenders
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 3)
      .map((o) => o.label);
    const { score, status } = lowerIsBetter(retries, 0, 2);
    metrics.push({
      weight: 2,
      metric: {
        id: "retry-waste",
        label: "Retry waste",
        value: retries,
        unit: "count",
        display: retries === 0 ? "none" : `${retries}`,
        score,
        status,
        detail:
          retries === 0
            ? "No command was re-run after failing."
            : `${retries} re-run(s) of failing commands burned about ${formatTokens(wasted)}.`,
        evidenceEventIds: evidence,
        reclaimableTokens: wasted,
        ...(retryOffenders.length > 0 ? { offenders: retryOffenders } : {})
      }
    });
  }

  // --- 7. yield density (progress per 1k tokens) ----------------------------
  if (totalInputTokens > 0) {
    const outcomes = editedPaths.size + okCommands;
    const density = outcomes / (totalInputTokens / 1000);
    const { score, status } = higherIsBetter(density, 0.05, 0.02);
    metrics.push({
      weight: 1,
      metric: {
        id: "yield-density",
        label: "Yield density",
        value: density,
        unit: "ratio",
        display: `${density.toFixed(3)}/k`,
        score,
        status,
        detail:
          status === "good"
            ? "The run turned tokens into concrete changes efficiently."
            : `${outcomes} outcome(s) across ${formatTokens(totalInputTokens)} — a lot of context for little change.`,
        evidenceEventIds: []
      }
    });
  }

  // --- 8. tool overhead (informational) -------------------------------------
  {
    const toolCalls = events.filter((e) => e.kind === "tool_call").length;
    const outcomes = Math.max(1, reads.length + edits.length + bashRuns.length);
    const ratio = toolCalls / outcomes;
    const { score, status } = lowerIsBetter(ratio, 2, 4);
    metrics.push({
      weight: 0.5,
      metric: {
        id: "tool-overhead",
        label: "Tool overhead",
        value: ratio,
        unit: "ratio",
        display: `${ratio.toFixed(1)}×`,
        score,
        status,
        detail:
          status === "good"
            ? "Tool calls translated into work without much churn."
            : "Many tool calls relative to concrete outcomes.",
        evidenceEventIds: []
      }
    });
  }

  // --- overall ---------------------------------------------------------------
  const weighted = metrics.filter((m) => m.weight > 0);
  const overallScore =
    weighted.length > 0
      ? Math.round(weighted.reduce((s, m) => s + m.metric.score * m.weight, 0) / weighted.reduce((s, m) => s + m.weight, 0))
      : 100;
  const reclaimableTokens = metrics.reduce((s, m) => s + (m.metric.reclaimableTokens ?? 0), 0);

  return {
    overallScore,
    status: overallScore >= 75 ? "good" : overallScore >= 50 ? "warn" : "bad",
    headline: buildHeadline(totalInputTokens, finalSnapshot, reclaimableTokens, hasRealTokens),
    totalInputTokens,
    reclaimableTokens,
    estimated: !hasRealTokens,
    metrics: metrics.map((m) => m.metric)
  };
}

function buildHeadline(
  totalInput: number,
  snap: TokenSnapshot | undefined,
  reclaimable: number,
  hasRealTokens: boolean
): string {
  const parts: string[] = [];
  if (totalInput > 0) parts.push(`${hasRealTokens ? "" : "~"}${formatTokens(totalInput)} input`);
  if (snap && (snap.cacheRead > 0 || snap.cacheWrite > 0)) {
    const denom = snap.cacheRead + snap.input;
    if (denom > 0) parts.push(`cache ${Math.round((snap.cacheRead / denom) * 100)}%`);
  }
  if (reclaimable > 0) parts.push(`~${formatTokens(reclaimable)} reclaimable`);
  return parts.join(" · ");
}

// --- scoring helpers ---------------------------------------------------------

function lowerIsBetter(value: number, warnAt: number, badAt: number): { score: number; status: EfficiencyStatus } {
  if (value <= warnAt) return { score: Math.round(lerp(value, 0, warnAt, 100, 80)), status: "good" };
  if (value <= badAt) return { score: Math.round(lerp(value, warnAt, badAt, 80, 40)), status: "warn" };
  return { score: Math.max(0, Math.round(lerp(value, badAt, badAt * 2, 40, 0))), status: "bad" };
}

function higherIsBetter(value: number, goodAt: number, badAt: number): { score: number; status: EfficiencyStatus } {
  if (value >= goodAt) return { score: Math.min(100, Math.round(lerp(value, goodAt, goodAt * 1.5, 80, 100))), status: "good" };
  if (value >= badAt) return { score: Math.round(lerp(value, badAt, goodAt, 40, 80)), status: "warn" };
  return { score: Math.max(0, Math.round(lerp(value, 0, badAt, 0, 40))), status: "bad" };
}

function lerp(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  const t = Math.max(0, Math.min(1, (value - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

// --- payload readers ---------------------------------------------------------

function numberAt(event: TraceEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringAt(event: TraceEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTokenSnapshot(event: TraceEvent): TokenSnapshot | undefined {
  const present =
    isRecordAtPath(event.payload, "properties.info.tokens") ||
    isRecordAtPath(event.payload, "properties.tokens") ||
    isRecordAtPath(event.payload, "tokens");
  if (!present) return undefined;
  return {
    input: deepNumber(event.payload, ["properties.info.tokens.input", "properties.tokens.input", "tokens.input"]) ?? 0,
    output: deepNumber(event.payload, ["properties.info.tokens.output", "properties.tokens.output", "tokens.output"]) ?? 0,
    reasoning:
      deepNumber(event.payload, ["properties.info.tokens.reasoning", "properties.tokens.reasoning", "tokens.reasoning"]) ?? 0,
    cacheRead:
      deepNumber(event.payload, [
        "properties.info.tokens.cache.read",
        "properties.tokens.cache.read",
        "tokens.cache.read",
        "properties.info.tokens.cacheRead",
        "tokens.cacheRead"
      ]) ?? 0,
    cacheWrite:
      deepNumber(event.payload, [
        "properties.info.tokens.cache.write",
        "properties.tokens.cache.write",
        "tokens.cache.write",
        "properties.info.tokens.cacheWrite",
        "tokens.cacheWrite"
      ]) ?? 0
  };
}

function deepNumber(payload: Record<string, unknown>, path: string | string[]): number | undefined {
  const paths = Array.isArray(path) ? path : [path];
  for (const p of paths) {
    const value = walk(payload, p);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRecordAtPath(payload: Record<string, unknown>, path: string): boolean {
  const value = walk(payload, path);
  return typeof value === "object" && value !== null;
}

function walk(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatTokens(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return `${Math.round(value)}`;
}
