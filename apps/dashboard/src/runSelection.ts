import type { TraceEvent } from "@agent-blackbox/core";

/**
 * Identify the most recently active run in a shared event log.
 *
 * Every recorder process starts its sequence at 1, so when several runs append
 * to the same log their `seq` values overlap. Selecting by `seq` would pin the
 * console to whichever run emitted the most events (an old, long run keeps
 * winning over a fresh one). Order by event timestamp instead, breaking ties by
 * append order so the newest run surfaces as soon as it produces an event.
 */
export function latestRunId(events: TraceEvent[]): string | null {
  let current: string | null = null;
  let latestStamp = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const parsed = Date.parse(event.ts);
    const stamp = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (stamp >= latestStamp) {
      latestStamp = stamp;
      current = event.runId;
    }
  }
  return current;
}

export function filterEventsForRun(events: TraceEvent[], runId: string | null): TraceEvent[] {
  if (!runId) return events;
  return events.filter((event) => event.runId === runId);
}

/**
 * List every distinct run in the log, most-recent first, with the wall-clock of
 * its latest event. Powers run navigation when one log holds multiple sessions.
 */
export function listRuns(events: TraceEvent[]): Array<{ runId: string; lastTs: string; eventCount: number }> {
  const runs = new Map<string, { runId: string; lastStamp: number; lastTs: string; eventCount: number }>();
  for (const event of events) {
    const parsed = Date.parse(event.ts);
    const stamp = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    const existing = runs.get(event.runId);
    if (!existing) {
      runs.set(event.runId, { runId: event.runId, lastStamp: stamp, lastTs: event.ts, eventCount: 1 });
      continue;
    }
    existing.eventCount += 1;
    if (stamp >= existing.lastStamp) {
      existing.lastStamp = stamp;
      existing.lastTs = event.ts;
    }
  }
  return [...runs.values()]
    .sort((a, b) => b.lastStamp - a.lastStamp)
    .map(({ runId, lastTs, eventCount }) => ({ runId, lastTs, eventCount }));
}
