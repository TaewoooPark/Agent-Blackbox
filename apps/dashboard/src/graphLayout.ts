import type { TraceEvent, WorkflowGraph, WorkflowNode } from "@agent-blackbox/core";

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

export type TimelineTone = "neutral" | "work" | "decision" | "risk" | "claim";

export type TimelineMark = {
  id: string;
  seq: number;
  kind: string;
  label: string;
  tone: TimelineTone;
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

export function createTimelineMarks(events: TraceEvent[]): TimelineMark[] {
  return events.map((event) => ({
    id: event.id,
    seq: event.seq,
    kind: event.kind,
    label: summarizeTraceEvent(event),
    tone: toneForEvent(event)
  }));
}

export function summarizeTraceEvent(event: TraceEvent): string {
  if (event.summary) {
    return event.summary;
  }
  const path = stringPayload(event, "path") ?? stringPayload(event, "file");
  if (path && event.kind === "file_read") return `Read ${path}`;
  if (path && event.kind === "file_edit") return `Edited ${path}`;
  if (path && event.kind === "file_created") return `Created ${path}`;
  if (path && event.kind === "file_deleted") return `Deleted ${path}`;
  const command = stringPayload(event, "command");
  if (command && event.kind === "bash") {
    const exitCode = numberPayload(event, "exitCode");
    return exitCode === undefined ? `Ran ${command}` : `Ran ${command} -> exit ${exitCode}`;
  }
  const statement = stringPayload(event, "statement");
  if (statement && event.kind === "decision_extracted") return `Decided: ${statement}`;
  const text = stringPayload(event, "text") ?? stringPayload(event, "content");
  if (text && event.kind === "message") return `Claim/message: ${shorten(text)}`;
  return event.kind.replace(/_/g, " ");
}

export function visibleEventsForGraph(events: TraceEvent[], graph: WorkflowGraph): TraceEvent[] {
  const visibleIds = new Set(graph.appliedEventIds);
  return events.filter((event) => visibleIds.has(event.id));
}

function toneForEvent(event: TraceEvent): TimelineTone {
  if (event.kind === "decision_extracted" || event.kind === "handoff_generated") return "decision";
  if (event.kind === "message" && event.evidence.claimedByModel) return "claim";
  if (
    event.kind === "session_error" ||
    event.kind === "blocker_detected" ||
    event.kind === "permission_asked" ||
    (event.kind === "bash" && numberPayload(event, "exitCode") !== undefined && numberPayload(event, "exitCode") !== 0)
  ) {
    return "risk";
  }
  if (
    event.kind === "tool_call" ||
    event.kind === "tool_result" ||
    event.kind === "file_read" ||
    event.kind === "file_edit" ||
    event.kind === "bash" ||
    event.kind === "search"
  ) {
    return "work";
  }
  return "neutral";
}

function stringPayload(event: TraceEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function numberPayload(event: TraceEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" ? value : undefined;
}

function shorten(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}
