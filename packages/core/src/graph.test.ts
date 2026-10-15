import { describe, expect, it } from "vitest";
import { createEventSequencer, createTraceEvent } from "./events.js";
import {
  diffWorkflowGraphs,
  materializeWorkflowGraph,
  replayWorkflowGraphAtSeq,
  replayWorkflowGraphAtTime
} from "./graph.js";

it("keeps a failed Motifcode child and its turn failed without ending the parent", () => {
  const sequencer = createEventSequencer({ host: "motifcode", runId: "motif-run", sessionId: "motif-run" });
  const child = { agentId: "review-1", agentRole: "subagent" as const, turnId: "review-turn-1" };
  const graph = materializeWorkflowGraph([
    sequencer.next({ kind: "session_created" }),
    sequencer.next({ ...child, kind: "agent_start" }),
    sequencer.next({ ...child, kind: "turn_start" }),
    sequencer.next({ ...child, kind: "bash", payload: { command: "npm test", success: false } }),
    sequencer.next({ ...child, kind: "turn_end", payload: { success: false, reason: "transport_error" } }),
    sequencer.next({ ...child, kind: "agent_end", payload: { success: false, reason: "transport_error" } })
  ]);
  expect(graph.nodes.find((node) => node.type === "SESSION")?.status).toBe("ACTIVE");
  expect(graph.nodes.find((node) => node.type === "AGENT")?.status).toBe("FAILED");
  expect(graph.nodes.find((node) => node.type === "TURN")?.status).toBe("FAILED");
  expect(graph.nodes.find((node) => node.type === "COMMAND")?.status).toBe("FAILED");
});

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
  it("settles permission replies from explicit decisions instead of leaving them waiting", () => {
    const seq = createEventSequencer({ host: "motifcode", runId: "r", sessionId: "r" });
    const graph = materializeWorkflowGraph([
      seq.next({ kind: "permission_asked", payload: { callID: "pending" } }),
      seq.next({ kind: "permission_replied", payload: { decision: "deny" } }),
      seq.next({ kind: "permission_replied", payload: { decision: "allow" } }),
      seq.next({ kind: "permission_replied", payload: { decision: "future-value" } }),
      seq.next({ kind: "permission_replied", payload: { properties: { decision: "deny" } } })
    ]);
    const gates = graph.nodes.filter((node) => node.type === "PERMISSION_GATE");
    expect(gates.map((gate) => gate.status)).toEqual(["NEEDS_APPROVAL", "BLOCKED", "SUCCEEDED", "UNKNOWN", "BLOCKED"]);
    expect(graph.edges.find((edge) => edge.to === gates[2]?.id)?.type).toBe("UNBLOCKS");
    expect(graph.edges.find((edge) => edge.to === gates[3]?.id)?.type).toBe("CONTAINS");
  });

  it("completes call nodes from specialized results and keeps replay before results active", () => {
    const seq = createEventSequencer({ host: "motifcode", runId: "r", sessionId: "r" });
    const events = [
      seq.next({ kind: "tool_call", payload: { callID: "read-1", tool: "read" } }),
      seq.next({ kind: "file_read", payload: { callID: "read-1", path: "file.ts", success: true } }),
      seq.next({ kind: "tool_call", payload: { callID: "bash-1", tool: "bash" } }),
      seq.next({ kind: "bash", payload: { callID: "bash-1", command: "npm test", success: false } }),
      seq.next({ kind: "tool_call", payload: { callID: "write-1", tool: "write" } }),
      seq.next({ kind: "file_edit", payload: { callID: "unrelated", path: "other.ts", success: true } })
    ];
    const graph = materializeWorkflowGraph(events);
    expect(graph.nodes.filter((node) => node.data.eventKind === "tool_call").map((node) => node.status)).toEqual(["SUCCEEDED", "FAILED", "ACTIVE"]);
    const first = graph.nodes.find((node) => node.data.callID === "read-1");
    expect(first?.eventIds).toEqual([events[0]!.id, events[1]!.id]);
    expect(replayWorkflowGraphAtSeq(events, 1).nodes.find((node) => node.type === "TOOL_CALL")?.status).toBe("ACTIVE");
  });

  it("pairs identical tool IDs only within their session and agent lane", () => {
    const seq = createEventSequencer({ host: "motifcode", runId: "r", sessionId: "r" });
    const child = { agentId: "child", agentRole: "subagent" as const };
    const events = [
      seq.next({ kind: "tool_call", payload: { callID: "1", tool: "read" } }),
      seq.next({ ...child, kind: "tool_call", payload: { callID: "1", tool: "read" } }),
      seq.next({ ...child, kind: "file_read", payload: { callID: "1", path: "child.ts", success: true } })
    ];
    expect(materializeWorkflowGraph(events).nodes.filter((node) => node.data.eventKind === "tool_call").map((node) => node.status)).toEqual(["ACTIVE", "SUCCEEDED"]);
    events.push(seq.next({ kind: "tool_result", payload: { callID: "1", tool: "read", success: false } }));
    expect(materializeWorkflowGraph(events).nodes.filter((node) => node.data.eventKind === "tool_call").map((node) => node.status)).toEqual(["FAILED", "SUCCEEDED"]);
  });

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

describe("agent lane labels", () => {
  it("keeps lane identity on agentId, exposes a readable name, and never merges same-named agents", () => {
    const mk = (seq: number, agentId: string) =>
      createTraceEvent(seq, {
        host: "claude-code",
        runId: "r",
        sessionId: "r",
        agentId,
        agentRole: "subagent",
        agentLabel: "security auditor", // two different agents share a readable name
        kind: "file_read",
        payload: { path: `f${seq}.ts`, chars: 10 }
      });
    const graph = materializeWorkflowGraph([mk(1, "a1"), mk(2, "a2")]);
    const lanes = graph.nodes.filter((node) => node.type === "AGENT" && node.id.startsWith("agent:"));
    // Two distinct agentIds → two distinct lanes despite the shared display name.
    expect(lanes).toHaveLength(2);
    expect(new Set(lanes.map((node) => node.label))).toEqual(new Set(["a1", "a2"])); // identity = agentId
    expect(lanes.every((node) => node.data?.agentName === "security auditor")).toBe(true); // readable, separate
  });

  it("prefers a concise role label over a long prompt-derived one, regardless of order", () => {
    const ev = (seq: number, label: string) =>
      createTraceEvent(seq, {
        host: "claude-code",
        runId: "r",
        sessionId: "r",
        agentId: "x1",
        agentRole: "subagent",
        agentLabel: label,
        kind: "file_read",
        payload: { path: `f${seq}.ts`, chars: 10 }
      });
    const prompt = "Adversarially verify this claimed bug in calc.ts and report";
    // prompt arrives first, the concise spawn name second
    const a = materializeWorkflowGraph([ev(1, prompt), ev(2, "workflow:urp-report-korean")]);
    expect(a.nodes.find((n) => n.id === "agent:x1")?.data?.agentName).toBe("workflow:urp-report-korean");
    // and the other way round — concise first, prompt second → still concise
    const b = materializeWorkflowGraph([ev(1, "general-purpose"), ev(2, prompt)]);
    expect(b.nodes.find((n) => n.id === "agent:x1")?.data?.agentName).toBe("general-purpose");
    // a generic placeholder is replaced by anything more specific
    const c = materializeWorkflowGraph([ev(1, "subagent"), ev(2, prompt)]);
    expect(c.nodes.find((n) => n.id === "agent:x1")?.data?.agentName).toBe(prompt);
  });
});
