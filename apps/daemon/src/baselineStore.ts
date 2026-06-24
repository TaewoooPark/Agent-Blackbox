import {
  BASELINE_MAX_HISTORY,
  computeEfficiencyReport,
  upsertRunSummary,
  type RunSummary,
  type TraceEvent
} from "@agent-blackbox/core";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Daemon-side persistence for relative baselines. Holds the per-archetype run
// history in memory (loaded once), records the recent runs' summaries on a
// throttle, and flushes to <dataDir>/baselines.json occasionally. Every path is
// best-effort: a read/parse/write failure degrades to an empty/last-known history
// and NEVER propagates into the snapshot build.

type StoreState = {
  history: RunSummary[];
  loaded: boolean;
  lastRecord: number;
  lastFlush: number;
  dirty: boolean;
};

const stores = new Map<string, StoreState>();
const RECORD_INTERVAL_MS = 20_000;
const FLUSH_INTERVAL_MS = 30_000;
const MIN_EVENTS_TO_RECORD = 5;

function baselinePath(eventsFile: string): string {
  return join(dirname(eventsFile), "baselines.json");
}

function isValidSummary(v: unknown): v is RunSummary {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RunSummary).runId === "string" &&
    typeof (v as RunSummary).ts === "string" &&
    typeof (v as RunSummary).archetype === "string" &&
    typeof (v as RunSummary).score === "number" &&
    typeof (v as RunSummary).inputTokens === "number"
  );
}

async function ensureLoaded(eventsFile: string): Promise<StoreState> {
  const existing = stores.get(eventsFile);
  if (existing && existing.loaded) return existing;
  const state: StoreState = existing ?? { history: [], loaded: false, lastRecord: 0, lastFlush: 0, dirty: false };
  stores.set(eventsFile, state);
  try {
    const raw = await readFile(baselinePath(eventsFile), "utf8");
    const parsed = JSON.parse(raw) as { history?: unknown };
    if (Array.isArray(parsed.history)) state.history = parsed.history.filter(isValidSummary).slice(0, BASELINE_MAX_HISTORY);
  } catch {
    // missing or corrupt → start empty
  }
  state.loaded = true;
  return state;
}

async function flush(eventsFile: string, state: StoreState): Promise<void> {
  const path = baselinePath(eventsFile);
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ history: state.history }, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch {
    // best-effort: a failed flush just means we re-record next interval
  }
}

// Record actionable runs from the current event window (throttled) and return the
// in-memory history for the snapshot. Never throws.
export async function updateBaselines(eventsFile: string, events: TraceEvent[], now = Date.now()): Promise<RunSummary[]> {
  let state: StoreState;
  try {
    state = await ensureLoaded(eventsFile);
  } catch {
    return [];
  }
  if (now - state.lastRecord < RECORD_INTERVAL_MS) return state.history;
  state.lastRecord = now;
  try {
    const byRun = new Map<string, TraceEvent[]>();
    for (const e of events) {
      const list = byRun.get(e.runId) ?? [];
      list.push(e);
      byRun.set(e.runId, list);
    }
    for (const [runId, runEvents] of byRun) {
      if (runEvents.length < MIN_EVENTS_TO_RECORD) continue;
      const didWork = runEvents.some(
        (e) => e.kind === "file_edit" || e.kind === "file_read" || e.kind === "file_created" || e.kind === "bash"
      );
      if (!didWork) continue;
      const report = computeEfficiencyReport(runEvents);
      const ts = runEvents.reduce((max, e) => (e.ts > max ? e.ts : max), "");
      state.history = upsertRunSummary(state.history, {
        runId,
        ts,
        archetype: report.archetype,
        score: report.overallScore,
        inputTokens: report.totalInputTokens
      });
      state.dirty = true;
    }
    if (state.dirty && now - state.lastFlush >= FLUSH_INTERVAL_MS) {
      await flush(eventsFile, state);
      state.lastFlush = now;
      state.dirty = false;
    }
  } catch {
    // any failure → keep the last-known history, don't disturb the snapshot
  }
  return state.history;
}

// Test/maintenance helper — drop cached state so a fresh load re-reads from disk.
export function resetBaselineCache(): void {
  stores.clear();
}
