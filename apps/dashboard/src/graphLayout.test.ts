import type { WorkflowGraph } from "@agent-blackbox/core";
import { createTraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";
import { createTimelineMarks, layoutGraphNodes, summarizeGraph, visibleEventsForGraph } from "./graphLayout.js";

const graph: WorkflowGraph = {
  runId: "run-ui",
  appliedEventIds: ["evt_1", "evt_2"],
  nodes: [
    {
      id: "agent:a",
      type: "AGENT",
      label: "a",
      status: "ACTIVE",
      createdAt: "2026-06-16T00:00:01.000Z",
      updatedAt: "2026-06-16T00:00:01.000Z",
      eventIds: ["evt_1"],
      data: {}
    },
    {
      id: "decision:d",
      type: "DECISION",
      label: "Use existing parser",
      status: "SUCCEEDED",
      createdAt: "2026-06-16T00:00:02.000Z",
      updatedAt: "2026-06-16T00:00:02.000Z",
      eventIds: ["evt_2"],
      data: {}
    }
  ],
  edges: []
};

describe("dashboard graph helpers", () => {
  it("summarizes operational graph state", () => {
    expect(summarizeGraph(graph)).toMatchObject({
      runId: "run-ui",
      nodes: 2,
      activeAgents: 1,
      decisions: 1
    });
  });

  it("places operational lanes deterministically", () => {
    const [agent, decision] = layoutGraphNodes(graph);

    expect(agent?.type).toBe("AGENT");
    expect(decision?.type).toBe("DECISION");
    expect(agent?.y).toBeLessThan(decision?.y ?? 0);
  });

  it("derives replay logs and visible events from observed trace state", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_read",
        payload: { path: "src/index.ts" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "bash",
        payload: { command: "npm test", exitCode: 1 }
      })
    ];

    const marks = createTimelineMarks(events);
    expect(marks.map((mark) => mark.label)).toEqual(["Read src/index.ts", "Ran npm test -> exit 1"]);
    expect(marks[1]?.tone).toBe("risk");
    expect(visibleEventsForGraph(events, { ...graph, appliedEventIds: [events[0]!.id] }).map((event) => event.id)).toEqual([
      events[0]!.id
    ]);
  });
});
