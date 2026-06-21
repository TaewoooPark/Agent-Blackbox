import {
  buildEfficiencyMemory,
  computeEfficiencyReport,
  hasManagedBlock,
  removeManagedBlock,
  upsertManagedBlock,
  type TraceEvent
} from "@agent-blackbox/core";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { loadTraceEvents } from "./server.js";

// The actuator half of the loop: ABB stops at advice today; `optimize` turns the
// last run's findings into a cache-safe memory block in AGENTS.md, then (on a
// later --check) compares the next run's score and rolls the block back if it
// didn't help. Every write is to a marked, reversible region — never silent.

export type OptimizeMode = "preview" | "apply" | "check" | "revert";

export type OptimizeResult = {
  mode: OptimizeMode;
  action: string;
  score: number | null;
  baselineScore: number | null;
  reclaimableTokens?: number | undefined; // projected savings the memory targets — shown without a re-run
  block: string | null;
  agentsMdPath: string;
  changed: boolean;
  applied: boolean; // does AGENTS.md currently hold our managed block? (so a caller can show apply vs revert)
};

type OptimizeState = {
  runId: string;
  baselineScore: number;
  baselineLatestTs: string; // newest event ts at apply — detects a new run even if runId is reused
  baselineFlagged: string[]; // metric ids flagged at apply, so --check can show what cleared
  fileExisted: boolean; // whether the memory file existed before apply (so revert can delete a file we created)
  appliedAt: string;
  memoryFile?: string; // the basename written (CLAUDE.md vs AGENTS.md) — so check/revert hit the same file even if the latest run's host later flips
};

// Which memory file the run's host actually reads back. Claude Code reads
// CLAUDE.md; OpenCode (and the generic default) read AGENTS.md.
function memoryFileFor(host: string | undefined): string {
  return host === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
}

const flaggedIds = (report: { metrics: { id: string; status: string }[] }): string[] =>
  report.metrics.filter((m) => m.status !== "good").map((m) => m.id);

// "redundant-reads, context-pressure" → human phrase, or "" when empty.
const joinIds = (ids: string[]): string => ids.join(", ");

// Only undo on a clear regression — run-to-run scores are noisy across tasks.
const REVERT_MARGIN = 3;

// Public entry: run the actuator, then stamp `applied` by reading AGENTS.md back —
// so callers (CLI, daemon HTTP, dashboard) get a single source of truth for
// whether our managed block is currently present, regardless of mode.
export async function runOptimize(options: {
  projectDir: string;
  mode: OptimizeMode;
  eventsFile?: string;
}): Promise<OptimizeResult> {
  const result = await computeOptimize(options);
  const content = await readMaybe(result.agentsMdPath);
  return { ...result, applied: content !== null && hasManagedBlock(content) };
}

async function computeOptimize(options: {
  projectDir: string;
  mode: OptimizeMode;
  eventsFile?: string;
}): Promise<Omit<OptimizeResult, "applied">> {
  const eventsFile = options.eventsFile ?? join(options.projectDir, ".agent-blackbox", "events.ndjson");
  const events = await loadTraceEvents(eventsFile);
  const { runId, events: runEvents } = latestRun(events);
  // Write AGENTS.md to the project the run actually happened in (carried on
  // event.cwd), not the daemon's own dir. This is what makes the actuator correct
  // in global-recorder mode, where one daemon records many projects and its
  // projectDir is the shared data dir. Older traces lack cwd → fall back.
  // `cwd` rides in on POSTed events, so treat it as untrusted: only honor an
  // absolute path (reject relative/odd values that could escape). The daemon's
  // loopback-only CORS is the primary guard against forged events; this is
  // defense-in-depth on the write target.
  const runCwd = runEvents.find((e) => typeof e.cwd === "string" && e.cwd.length > 0)?.cwd;
  const targetDir = runCwd && isAbsolute(runCwd) ? runCwd : options.projectDir;
  const runHost = runEvents.find((e) => typeof e.host === "string")?.host;
  const memoryFileName = memoryFileFor(runHost);
  const agentsMdPath = join(targetDir, memoryFileName);
  const statePath = join(targetDir, ".agent-blackbox", "optimization.json");
  const latestTs = runEvents.reduce((max, e) => (e.ts > max ? e.ts : max), "");
  const report = runEvents.length > 0 ? computeEfficiencyReport(runEvents) : null;
  const score = report ? report.overallScore : null;

  if (options.mode === "revert") {
    return revert(agentsMdPath, statePath, score);
  }

  const block = report ? buildEfficiencyMemory(report, { verifiedCommands: verifiedCommands(runEvents) }) : null;

  if (options.mode === "preview") {
    return {
      mode: "preview",
      action: block ? `Preview only — re-run with --apply to write this to ${memoryFileName}.` : "This run is clean — nothing worth pinning.",
      score,
      baselineScore: null,
      reclaimableTokens: report?.reclaimableTokens,
      block,
      agentsMdPath,
      changed: false
    };
  }

  if (options.mode === "apply") {
    if (!block || !report || score === null || runId === null) {
      return { mode: "apply", action: "This run is clean — nothing to apply.", score, baselineScore: null, block: null, agentsMdPath, changed: false };
    }
    const prior = await readMaybe(agentsMdPath);
    const next = upsertManagedBlock(prior ?? "", block);
    // Skip a redundant re-apply: when the managed block is already present and
    // byte-identical, don't churn AGENTS.md's mtime or reset the saved baseline.
    if (prior === null || next !== prior) {
      await writeFile(agentsMdPath, next, "utf8");
      await writeState(statePath, {
        runId: runId ?? "",
        baselineScore: score,
        baselineLatestTs: latestTs,
        baselineFlagged: flaggedIds(report),
        fileExisted: prior !== null,
        appliedAt: new Date().toISOString(),
        memoryFile: memoryFileName
      });
    }
    return {
      mode: "apply",
      action:
        `Wrote efficiency memory to ${memoryFileName} — targets ~${report.reclaimableTokens} reclaimable tokens on similar future runs (no re-run needed).` +
        ` Optional: re-run the same task + \`optimize --check\` to benchmark the gain.`,
      score,
      baselineScore: score,
      reclaimableTokens: report.reclaimableTokens,
      block,
      agentsMdPath,
      changed: prior !== next
    };
  }

  // check: measure the next run against the saved baseline and roll back if worse.
  const state = await readState(statePath);
  if (!state) {
    return { mode: "check", action: "Nothing applied yet — run `optimize --apply` first.", score, baselineScore: null, block: null, agentsMdPath, changed: false };
  }
  if (runId === null) {
    return { mode: "check", action: "No runs recorded yet.", score, baselineScore: state.baselineScore, block: null, agentsMdPath, changed: false };
  }
  // A new run is "newer activity since apply" by timestamp — robust even if the
  // runId was pinned/reused via AGENT_BLACKBOX_RUN_ID.
  if (latestTs <= state.baselineLatestTs) {
    return {
      mode: "check",
      action: "No new run since apply. Run your agent with the memory in place, then re-check.",
      score,
      baselineScore: state.baselineScore,
      block: null,
      agentsMdPath,
      changed: false
    };
  }
  const delta = (score ?? 0) - state.baselineScore;
  const nowFlagged = report ? flaggedIds(report) : [];
  const baseFlagged = state.baselineFlagged ?? [];
  const cleared = baseFlagged.filter((id) => !nowFlagged.includes(id));
  const appeared = nowFlagged.filter((id) => !baseFlagged.includes(id));
  const metricDiff = [cleared.length ? `cleared ${joinIds(cleared)}` : "", appeared.length ? `new ${joinIds(appeared)}` : ""]
    .filter(Boolean)
    .join("; ");
  const diffSuffix = metricDiff ? ` [${metricDiff}]` : "";
  if (delta < -REVERT_MARGIN) {
    // Roll back the file we actually wrote at apply (host may have flipped since).
    const appliedPath = state.memoryFile ? join(targetDir, state.memoryFile) : agentsMdPath;
    const changed = await restore(appliedPath, state.fileExisted);
    await rm(statePath, { force: true });
    return {
      mode: "check",
      action: `Score dropped ${state.baselineScore} → ${score ?? "?"} (Δ${delta})${diffSuffix} on the new run — rolled the memory back.`,
      score,
      baselineScore: state.baselineScore,
      block: null,
      agentsMdPath,
      changed
    };
  }
  return {
    mode: "check",
    action: `Score ${state.baselineScore} → ${score ?? "?"} (Δ${delta >= 0 ? "+" : ""}${delta})${diffSuffix} — kept the memory.`,
    score,
    baselineScore: state.baselineScore,
    block: null,
    agentsMdPath,
    changed: false
  };
}

async function revert(
  agentsMdPath: string,
  statePath: string,
  score: number | null
): Promise<Omit<OptimizeResult, "applied">> {
  const state = await readState(statePath);
  // Revert the file we wrote at apply, even if the latest run's host has since flipped.
  const path = state?.memoryFile ? join(dirname(agentsMdPath), state.memoryFile) : agentsMdPath;
  const changed = await restore(path, state ? state.fileExisted : true);
  if (state) await rm(statePath, { force: true });
  return {
    mode: "revert",
    action: changed ? `Removed the managed efficiency block from ${basename(path)}.` : "Nothing to revert.",
    score,
    baselineScore: state ? state.baselineScore : null,
    block: null,
    agentsMdPath: path,
    changed
  };
}

// Roll back by stripping ONLY our managed block, preserving any edits made to the
// rest of AGENTS.md since apply. If that empties a file we created, delete it.
async function restore(agentsMdPath: string, fileExisted: boolean): Promise<boolean> {
  const current = await readMaybe(agentsMdPath);
  if (current === null) return false;
  const next = removeManagedBlock(current);
  if (next === current) return false;
  if (next.trim() === "" && !fileExisted) {
    await rm(agentsMdPath, { force: true });
    return true;
  }
  await writeFile(agentsMdPath, next, "utf8");
  return true;
}

function latestRun(events: TraceEvent[]): { runId: string | null; events: TraceEvent[] } {
  let latest: TraceEvent | undefined;
  for (const e of events) if (!latest || e.ts > latest.ts) latest = e;
  if (!latest) return { runId: null, events: [] };
  const runId = latest.runId;
  return { runId, events: events.filter((e) => e.runId === runId) };
}

// Pin build/test/run commands worth reusing — not read-only exploration, which
// the next run should still do fresh against the current tree.
const NAV_VERBS = new Set([
  "ls", "pwd", "cat", "find", "grep", "rg", "fd", "head", "tail", "echo", "which",
  "env", "cd", "tree", "stat", "wc", "sort", "uniq", "clear", "sleep", "true", "false"
]);

function verifiedCommands(events: TraceEvent[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== "bash") continue;
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload || payload.exitCode !== 0) continue;
    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (!command || seen.has(command)) continue;
    const verb = command.split(/\s+/)[0] ?? "";
    if (NAV_VERBS.has(verb)) continue; // skip pure exploration/navigation
    seen.add(command);
    out.push(command);
  }
  return out;
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readState(path: string): Promise<OptimizeState | null> {
  const raw = await readMaybe(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OptimizeState;
  } catch {
    return null;
  }
}

async function writeState(path: string, state: OptimizeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
