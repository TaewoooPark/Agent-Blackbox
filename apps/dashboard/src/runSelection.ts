import type { TraceEvent } from "@agent-blackbox/core";

// Lifecycle/heartbeat events keep flowing even while a run is idle (e.g. a TUI
// session left open), so they must not count as "activity" when deciding which
// run is current — otherwise an idle session perpetually outranks a run that
// just did real work.
const heartbeatKinds = new Set<TraceEvent["kind"]>([
  "session_created",
  "session_updated",
  "session_idle",
  "session_error",
  "turn_start",
  "turn_end"
]);

type RunRank = {
  runId: string;
  meaningfulStamp: number;
  anyStamp: number;
  lastIndex: number;
  lastTs: string;
  eventCount: number;
};

function stampOf(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function rankRuns(events: TraceEvent[]): RunRank[] {
  const runs = new Map<string, RunRank>();
  events.forEach((event, index) => {
    const stamp = stampOf(event.ts);
    const existing = runs.get(event.runId);
    const rank: RunRank = existing ?? {
      runId: event.runId,
      meaningfulStamp: Number.NEGATIVE_INFINITY,
      anyStamp: Number.NEGATIVE_INFINITY,
      lastIndex: -1,
      lastTs: event.ts,
      eventCount: 0
    };
    rank.eventCount += 1;
    rank.lastIndex = index;
    if (stamp >= rank.anyStamp) {
      rank.anyStamp = stamp;
      rank.lastTs = event.ts;
    }
    if (!heartbeatKinds.has(event.kind) && stamp > rank.meaningfulStamp) {
      rank.meaningfulStamp = stamp;
    }
    runs.set(event.runId, rank);
  });
  // Most recent real work first; fall back to any event, then append order.
  return [...runs.values()].sort(
    (a, b) =>
      b.meaningfulStamp - a.meaningfulStamp || b.anyStamp - a.anyStamp || b.lastIndex - a.lastIndex
  );
}

/**
 * Identify the most recently *active* run in a shared event log. `seq` resets
 * per recorder process and idle sessions keep emitting heartbeats, so rank runs
 * by the timestamp of their latest meaningful (non-heartbeat) event, falling
 * back to any event and then append order.
 */
export function latestRunId(events: TraceEvent[]): string | null {
  const ranked = rankRuns(events);
  return ranked[0]?.runId ?? null;
}

export function filterEventsForRun(events: TraceEvent[], runId: string | null): TraceEvent[] {
  if (!runId) return events;
  return events.filter((event) => event.runId === runId);
}

/**
 * List every distinct run, most-recently-active first (by meaningful activity),
 * with the wall-clock of its latest event. Powers run navigation when one log
 * holds multiple sessions.
 */
export function listRuns(events: TraceEvent[]): Array<{ runId: string; lastTs: string; eventCount: number }> {
  return rankRuns(events).map(({ runId, lastTs, eventCount }) => ({ runId, lastTs, eventCount }));
}
