import {
  buildEfficiencyMemory,
  computeEfficiencyReport,
  hasManagedBlock,
  removeManagedBlock,
  upsertManagedBlock,
  type TraceEvent
} from "@agent-blackbox/core";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  block: string | null;
  agentsMdPath: string;
  changed: boolean;
};

type OptimizeState = {
  runId: string;
  baselineScore: number;
  priorContent: string | null; // exact AGENTS.md before apply (null = file did not exist)
  appliedAt: string;
};

// Only undo on a clear regression — run-to-run scores are noisy across tasks.
const REVERT_MARGIN = 3;

export async function runOptimize(options: { projectDir: string; mode: OptimizeMode }): Promise<OptimizeResult> {
  const eventsFile = join(options.projectDir, ".agent-blackbox", "events.ndjson");
  const agentsMdPath = join(options.projectDir, "AGENTS.md");
  const statePath = join(options.projectDir, ".agent-blackbox", "optimization.json");

  const events = await loadTraceEvents(eventsFile);
  const { runId, events: runEvents } = latestRun(events);
  const report = runEvents.length > 0 ? computeEfficiencyReport(runEvents) : null;
  const score = report ? report.overallScore : null;

  if (options.mode === "revert") {
    return revert(agentsMdPath, statePath, score);
  }

  const block = report ? buildEfficiencyMemory(report, { verifiedCommands: verifiedCommands(runEvents) }) : null;

  if (options.mode === "preview") {
    return {
      mode: "preview",
      action: block ? "Preview only — re-run with --apply to write this to AGENTS.md." : "This run is clean — nothing worth pinning.",
      score,
      baselineScore: null,
      block,
      agentsMdPath,
      changed: false
    };
  }

  if (options.mode === "apply") {
    if (!block || score === null || runId === null) {
      return { mode: "apply", action: "This run is clean — nothing to apply.", score, baselineScore: null, block: null, agentsMdPath, changed: false };
    }
    const prior = await readMaybe(agentsMdPath);
    const next = upsertManagedBlock(prior ?? "", block);
    await writeFile(agentsMdPath, next, "utf8");
    await writeState(statePath, { runId, baselineScore: score, priorContent: prior, appliedAt: new Date().toISOString() });
    return {
      mode: "apply",
      action: `Wrote efficiency memory to AGENTS.md (baseline score ${score}). Run your agent again, then \`optimize --check\` to confirm it helped.`,
      score,
      baselineScore: score,
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
  if (runId === state.runId) {
    return {
      mode: "check",
      action: `No new run since apply (still '${runId}'). Run your agent with the memory in place, then re-check.`,
      score,
      baselineScore: state.baselineScore,
      block: null,
      agentsMdPath,
      changed: false
    };
  }
  const delta = (score ?? 0) - state.baselineScore;
  if (delta < -REVERT_MARGIN) {
    await restore(agentsMdPath, state.priorContent);
    await rm(statePath, { force: true });
    return {
      mode: "check",
      action: `Score dropped ${state.baselineScore} → ${score ?? "?"} (Δ${delta}) on the new run — rolled the memory back.`,
      score,
      baselineScore: state.baselineScore,
      block: null,
      agentsMdPath,
      changed: true
    };
  }
  return {
    mode: "check",
    action: `Score ${state.baselineScore} → ${score ?? "?"} (Δ${delta >= 0 ? "+" : ""}${delta}) — kept the memory.`,
    score,
    baselineScore: state.baselineScore,
    block: null,
    agentsMdPath,
    changed: false
  };
}

async function revert(agentsMdPath: string, statePath: string, score: number | null): Promise<OptimizeResult> {
  const state = await readState(statePath);
  const current = await readMaybe(agentsMdPath);
  if (state) {
    await restore(agentsMdPath, state.priorContent);
    await rm(statePath, { force: true });
    return { mode: "revert", action: "Restored AGENTS.md to its pre-apply state.", score, baselineScore: state.baselineScore, block: null, agentsMdPath, changed: true };
  }
  if (current !== null && hasManagedBlock(current)) {
    await writeFile(agentsMdPath, removeManagedBlock(current), "utf8");
    return { mode: "revert", action: "Removed the managed efficiency block from AGENTS.md.", score, baselineScore: null, block: null, agentsMdPath, changed: true };
  }
  return { mode: "revert", action: "Nothing to revert.", score, baselineScore: null, block: null, agentsMdPath, changed: false };
}

async function restore(agentsMdPath: string, priorContent: string | null): Promise<void> {
  if (priorContent === null) await rm(agentsMdPath, { force: true });
  else await writeFile(agentsMdPath, priorContent, "utf8");
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
