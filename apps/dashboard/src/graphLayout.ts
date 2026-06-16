import type { WorkflowGraph, WorkflowNode } from "@agent-blackbox/core";

export type PositionedNode = WorkflowNode & {
  x: number;
  y: number;
};

export type DashboardSummary = {
  runId: string;
  nodes: number;
  edges: number;
  events: number;
  activeAgents: number;
  failures: number;
  decisions: number;
};

const laneByType: Record<string, number> = {
  RUN: 0,
  SESSION: 0,
  AGENT: 1,
  TURN: 2,
  TOOL_CALL: 3,
  COMMAND: 4,
  SEARCH: 4,
  FILE: 5,
  ARTIFACT: 5,
  DECISION: 6,
  BLOCKER: 7,
  ERROR: 7,
  PERMISSION_GATE: 7,
  MESSAGE: 8,
  TODO: 8,
  HANDOFF: 8,
  HYPOTHESIS: 8
};

export function summarizeGraph(graph: WorkflowGraph): DashboardSummary {
  return {
    runId: graph.runId,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    events: graph.appliedEventIds.length,
    activeAgents: graph.nodes.filter((node) => node.type === "AGENT" && node.status === "ACTIVE").length,
    failures: graph.nodes.filter((node) => node.status === "FAILED").length,
    decisions: graph.nodes.filter((node) => node.type === "DECISION").length
  };
}

export function layoutGraphNodes(graph: WorkflowGraph): PositionedNode[] {
  const ordered = [...graph.nodes].sort((a, b) => {
    const laneDelta = (laneByType[a.type] ?? 8) - (laneByType[b.type] ?? 8);
    if (laneDelta !== 0) return laneDelta;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
  const laneCounts = new Map<number, number>();
  return ordered.map((node) => {
    const lane = laneByType[node.type] ?? 8;
    const index = laneCounts.get(lane) ?? 0;
    laneCounts.set(lane, index + 1);
    return {
      ...node,
      x: 32 + index * 184,
      y: 24 + lane * 82
    };
  });
}
