import type { TraceEvent } from "./events.js";

/**
 * Motifcode backfill may arrive after newer live events. Its sequence numbers
 * follow the source journal, so analyses must restore that order within a run.
 * Keep each run's existing slots and other hosts' order: sequence numbers from
 * separate runs are not comparable. Never mutate the store/stream input array.
 */
export function orderEventsForAnalysis(events: TraceEvent[]): TraceEvent[] {
  const runs = new Map<string, { events: TraceEvent[]; slots: number[]; unordered: boolean }>();
  events.forEach((event, slot) => {
    if (event.host !== "motifcode") return;
    let run = runs.get(event.runId);
    if (!run) {
      run = { events: [], slots: [], unordered: false };
      runs.set(event.runId, run);
    }
    const previous = run.events[run.events.length - 1];
    if (previous && previous.seq > event.seq) run.unordered = true;
    run.events.push(event);
    run.slots.push(slot);
  });

  let ordered = events;
  for (const run of runs.values()) {
    if (!run.unordered) continue;
    if (ordered === events) ordered = [...events];
    run.events.sort((a, b) => a.seq - b.seq);
    run.slots.forEach((slot, index) => { ordered[slot] = run.events[index]!; });
  }
  return ordered;
}
