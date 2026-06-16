import { describe, expect, it } from "vitest";
import { createEventSequencer } from "./events.js";
import {
  diffWorkflowGraphs,
  materializeWorkflowGraph,
  replayWorkflowGraphAtSeq,
  replayWorkflowGraphAtTime
} from "./graph.js";

function fixtureEvents() {
  const sequencer = createEventSequencer({
    host: "opencode",
    runId: "run-graph",
    sessionId: "session-main",
    agentId: "agent-main",
    agentRole: "primary"
  });

  return [
    sequencer.next({ kind: "session_created", ts: "2026-06-16T00:00:00.000Z" }),
    sequencer.next({ kind: "agent_start", ts: "2026-06-16T00:00:01.000Z" }),
    sequencer.next({ kind: "turn_start", turnId: "turn-1", ts: "2026-06-16T00:00:02.000Z" }),
    sequencer.next({
      kind: "file_read",
      turnId: "turn-1",
      ts: "2026-06-16T00:00:03.000Z",
      payload: { path: "src/parser.ts" }
    }),
    sequencer.next({
      kind: "file_edit",
      turnId: "turn-1",
      ts: "2026-06-16T00:00:04.000Z",
      payload: { path: "src/parser.ts", additions: 3 }
    }),
    sequencer.next({
      kind: "bash",
      turnId: "turn-1",
      ts: "2026-06-16T00:00:05.000Z",
      payload: { command: "npm test", exitCode: 1 }
    }),
    sequencer.next({
      kind: "file_edit",
      turnId: "turn-1",
      ts: "2026-06-16T00:00:06.000Z",
      payload: { path: "src/parser.test.ts", additions: 1 }
    }),
    sequencer.next({
      kind: "bash",
      turnId: "turn-1",
      ts: "2026-06-16T00:00:07.000Z",
      payload: { command: "npm test", exitCode: 0 }
    }),
    sequencer.next({
      kind: "decision_extracted",
      turnId: "turn-1",
      ts: "2026-06-16T00:00:08.000Z",
      payload: {
        statement: "Patch the existing parser instead of adding a new abstraction.",
        confidence: 0.82,
        evidenceEventIds: ["evt_run-graph_000004", "evt_run-graph_000006", "evt_run-graph_000008"]
      }
    })
  ];
}

describe("workflow graph materialization", () => {
  it("turns trace events into operational nodes and edges", () => {
    const graph = materializeWorkflowGraph(fixtureEvents());

    expect(graph.nodes.some((node) => node.type === "RUN" && node.label === "run-graph")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "FILE" && node.label === "src/parser.ts")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "COMMAND" && node.status === "FAILED")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "COMMAND" && node.status === "SUCCEEDED")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "DECISION")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "READS")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "EDITS")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "SUPPORTS_DECISION" && edge.inferred)).toBe(true);
  });

  it("replays graph state by sequence", () => {
    const graph = replayWorkflowGraphAtSeq(fixtureEvents(), 6);

    expect(graph.appliedEventIds).toHaveLength(6);
    expect(graph.nodes.some((node) => node.type === "COMMAND" && node.status === "FAILED")).toBe(true);
    expect(graph.nodes.some((node) => node.label === "src/parser.test.ts")).toBe(false);
    expect(graph.nodes.some((node) => node.type === "DECISION")).toBe(false);
  });

  it("replays graph state by timestamp", () => {
    const graph = replayWorkflowGraphAtTime(fixtureEvents(), "2026-06-16T00:00:05.500Z");

    expect(graph.appliedEventIds).toHaveLength(6);
    expect(graph.nodes.some((node) => node.type === "COMMAND" && node.status === "FAILED")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "DECISION")).toBe(false);
  });

  it("diffs two replay points", () => {
    const before = replayWorkflowGraphAtSeq(fixtureEvents(), 6);
    const after = materializeWorkflowGraph(fixtureEvents());
    const diff = diffWorkflowGraphs(before, after);

    expect(diff.addedNodeIds.some((id) => id.includes("parser.test.ts"))).toBe(true);
    expect(diff.addedNodeIds.some((id) => id.includes("000009"))).toBe(true);
    expect(diff.removedNodeIds).toEqual([]);
  });

  it("extracts file paths from nested provider payloads", () => {
    const sequencer = createEventSequencer({
      host: "opencode",
      runId: "run-graph",
      sessionId: "session-main"
    });
    const graph = materializeWorkflowGraph([
      sequencer.next({
        kind: "file_edit",
        payload: {
          properties: {
            file: "$PROJECT/src/calc.js"
          }
        }
      })
    ]);

    expect(graph.nodes.some((node) => node.type === "FILE" && node.label === "$PROJECT/src/calc.js")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "FILE" && node.label === "unknown-file")).toBe(false);
  });
});
