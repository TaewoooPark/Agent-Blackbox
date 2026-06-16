import { createTraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";
import { filterEventsForRun, latestRunId, listRuns } from "./runSelection.js";

function event(seq: number, runId: string, ts: string) {
  return createTraceEvent(seq, {
    ts,
    host: "opencode",
    runId,
    sessionId: `session-${runId}`,
    kind: "session_updated"
  });
}

describe("run selection", () => {
  it("returns null for an empty log", () => {
    expect(latestRunId([])).toBeNull();
  });

  it("selects the most recent run by timestamp, not sequence", () => {
    // A long-lived old run reached a high seq; a fresh run restarts at seq 1.
    const events = [
      event(800, "old-run", "2026-06-16T01:30:00.000Z"),
      event(824, "old-run", "2026-06-16T01:45:00.000Z"),
      event(1, "new-run", "2026-06-16T10:58:00.000Z"),
      event(2, "new-run", "2026-06-16T10:58:05.000Z")
    ];

    // Selecting by seq would wrongly stick on "old-run" (seq 824 > 2).
    expect(latestRunId(events)).toBe("new-run");
  });

  it("breaks timestamp ties by append order so the newest run wins", () => {
    const ts = "2026-06-16T10:58:00.000Z";
    const events = [event(824, "old-run", ts), event(1, "new-run", ts)];
    expect(latestRunId(events)).toBe("new-run");
  });

  it("falls back gracefully when timestamps are unparseable", () => {
    const events = [event(5, "first", "not-a-date"), event(6, "second", "also-bad")];
    expect(latestRunId(events)).toBe("second");
  });

  it("filters events down to a single run", () => {
    const events = [
      event(1, "old-run", "2026-06-16T01:30:00.000Z"),
      event(1, "new-run", "2026-06-16T10:58:00.000Z"),
      event(2, "new-run", "2026-06-16T10:58:05.000Z")
    ];
    const filtered = filterEventsForRun(events, latestRunId(events));
    expect(filtered).toHaveLength(2);
    expect(filtered.every((entry) => entry.runId === "new-run")).toBe(true);
  });

  it("returns every event when no run is selected", () => {
    const events = [event(1, "a", "2026-06-16T01:30:00.000Z")];
    expect(filterEventsForRun(events, null)).toHaveLength(1);
  });

  it("lists runs most-recent first with counts", () => {
    const events = [
      event(1, "old-run", "2026-06-16T01:30:00.000Z"),
      event(2, "old-run", "2026-06-16T01:45:00.000Z"),
      event(1, "new-run", "2026-06-16T10:58:00.000Z")
    ];
    const runs = listRuns(events);
    expect(runs.map((run) => run.runId)).toEqual(["new-run", "old-run"]);
    expect(runs[0]?.eventCount).toBe(1);
    expect(runs[1]?.eventCount).toBe(2);
  });
});
