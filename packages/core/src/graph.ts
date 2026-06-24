import type { TraceEvent } from "./events.js";
import type { JsonObject } from "./json.js";

export const workflowNodeTypes = [
  "RUN",
  "SESSION",
  "AGENT",
  "TURN",
  "MESSAGE",
  "TOOL_CALL",
  "FILE",
  "COMMAND",
  "SEARCH",
  "TODO",
  "DECISION",
  "HYPOTHESIS",
  "BLOCKER",
  "ERROR",
  "ARTIFACT",
  "PERMISSION_GATE",
  "HANDOFF"
] as const;

export type WorkflowNodeType = (typeof workflowNodeTypes)[number];

export const workflowEdgeTypes = [
  "CONTAINS",
  "SPAWNS",
  "CALLS",
  "READS",
  "EDITS",
  "CREATES",
  "DELETES",
  "EXECUTES",
  "SEARCHES",
  "PRODUCES",
  "UPDATES",
  "DECIDES",
  "SUPPORTS_DECISION",
  "REFUTES_DECISION",
  "BLOCKS",
  "UNBLOCKS",
  "DEPENDS_ON",
  "REPLACES",
  "ROLLS_BACK",
  "CLAIMS",
  "OBSERVED_AS"
] as const;

export type WorkflowEdgeType = (typeof workflowEdgeTypes)[number];

export const workflowStatuses = [
  "PENDING",
  "ACTIVE",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "NEEDS_APPROVAL",
  "REVERTED",
  "STALE",
  "UNKNOWN"
] as const;

export type WorkflowStatus = (typeof workflowStatuses)[number];

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  label: string;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  eventIds: string[];
  data: JsonObject;
};

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  type: WorkflowEdgeType;
  label?: string;
  createdAt: string;
  updatedAt: string;
  eventIds: string[];
  inferred: boolean;
  confidence: number;
};

export type WorkflowGraph = {
  runId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  appliedEventIds: string[];
};

export type GraphDiff = {
  addedNodeIds: string[];
  removedNodeIds: string[];
  addedEdgeIds: string[];
  removedEdgeIds: string[];
};

type MutableGraph = {
  runId: string;
  nodes: Map<string, WorkflowNode>;
  edges: Map<string, WorkflowEdge>;
  appliedEventIds: string[];
};

export function materializeWorkflowGraph(events: TraceEvent[]): WorkflowGraph {
  const sorted = sortEvents(events);
  const runId = sorted[0]?.runId ?? "empty-run";
  const graph: MutableGraph = {
    runId,
    nodes: new Map(),
    edges: new Map(),
    appliedEventIds: []
  };

  ensureNode(graph, {
    id: runNodeId(runId),
    type: "RUN",
    label: runId,
    status: sorted.length > 0 ? "ACTIVE" : "UNKNOWN",
    at: sorted[0]?.ts ?? new Date(0).toISOString(),
    ...(sorted[0]?.id ? { eventId: sorted[0].id } : {}),
    data: { runId }
  });

  for (const event of sorted) {
    applyTraceEvent(graph, event);
  }

  return freezeGraph(graph);
}

export function replayWorkflowGraphAtSeq(events: TraceEvent[], seq: number): WorkflowGraph {
  return materializeWorkflowGraph(events.filter((event) => event.seq <= seq));
}

export function replayWorkflowGraphAtTime(events: TraceEvent[], at: string | Date): WorkflowGraph {
  const atTime = new Date(at).getTime();
  if (Number.isNaN(atTime)) {
    throw new Error("replayWorkflowGraphAtTime: invalid time");
  }
  return materializeWorkflowGraph(events.filter((event) => new Date(event.ts).getTime() <= atTime));
}

export function diffWorkflowGraphs(before: WorkflowGraph, after: WorkflowGraph): GraphDiff {
  const beforeNodes = new Set(before.nodes.map((node) => node.id));
  const afterNodes = new Set(after.nodes.map((node) => node.id));
  const beforeEdges = new Set(before.edges.map((edge) => edge.id));
  const afterEdges = new Set(after.edges.map((edge) => edge.id));
  return {
    addedNodeIds: [...afterNodes].filter((id) => !beforeNodes.has(id)).sort(),
    removedNodeIds: [...beforeNodes].filter((id) => !afterNodes.has(id)).sort(),
    addedEdgeIds: [...afterEdges].filter((id) => !beforeEdges.has(id)).sort(),
    removedEdgeIds: [...beforeEdges].filter((id) => !afterEdges.has(id)).sort()
  };
}

function applyTraceEvent(graph: MutableGraph, event: TraceEvent): void {
  graph.appliedEventIds.push(event.id);
  ensureSession(graph, event);
  if (event.agentId) {
    ensureAgent(graph, event);
  }
  if (event.turnId) {
    ensureTurn(graph, event);
  }

  switch (event.kind) {
    case "session_created":
    case "session_updated":
      updateNodeStatus(graph, sessionNodeId(event.sessionId), "ACTIVE", event);
      break;
    case "session_idle":
      updateNodeStatus(graph, sessionNodeId(event.sessionId), "SUCCEEDED", event);
      break;
    case "session_error":
      updateNodeStatus(graph, sessionNodeId(event.sessionId), "FAILED", event);
      createEventNode(graph, event, "ERROR", event.summary ?? "Session error", "FAILED");
      connectScope(graph, event, eventNodeId(event), "PRODUCES");
      break;
    case "agent_start":
      if (event.agentId) {
        updateNodeStatus(graph, agentNodeId(event.agentId), "ACTIVE", event);
      }
      break;
    case "agent_end":
      if (event.agentId) {
        updateNodeStatus(graph, agentNodeId(event.agentId), "SUCCEEDED", event);
      }
      break;
    case "turn_start":
      if (event.turnId) {
        updateNodeStatus(graph, turnNodeId(event.turnId), "ACTIVE", event);
      }
      break;
    case "turn_end":
      if (event.turnId) {
        updateNodeStatus(graph, turnNodeId(event.turnId), "SUCCEEDED", event);
      }
      break;
    case "message":
      createEventNode(graph, event, "MESSAGE", event.summary ?? messageLabel(event), "SUCCEEDED");
      connectScope(graph, event, eventNodeId(event), event.evidence.claimedByModel ? "CLAIMS" : "CONTAINS");
      break;
    case "tool_call":
      createEventNode(graph, event, "TOOL_CALL", event.summary ?? toolLabel(event), "ACTIVE");
      connectScope(graph, event, eventNodeId(event), "CALLS");
      break;
    case "tool_result":
      createEventNode(graph, event, "TOOL_CALL", event.summary ?? "Tool result", resultStatus(event));
      connectScope(graph, event, eventNodeId(event), "OBSERVED_AS");
      break;
    case "file_read":
    case "file_edit":
    case "file_created":
    case "file_deleted":
      createFileActivity(graph, event);
      break;
    case "bash":
      createEventNode(graph, event, "COMMAND", event.summary ?? commandLabel(event), resultStatus(event));
      connectScope(graph, event, eventNodeId(event), "EXECUTES");
      break;
    case "search":
      createEventNode(graph, event, "SEARCH", event.summary ?? searchLabel(event), "SUCCEEDED");
      connectScope(graph, event, eventNodeId(event), "SEARCHES");
      break;
    case "todo_updated":
      createEventNode(graph, event, "TODO", event.summary ?? "Todo update", "ACTIVE");
      connectScope(graph, event, eventNodeId(event), "UPDATES");
      break;
    case "permission_asked":
    case "permission_replied":
      createEventNode(graph, event, "PERMISSION_GATE", event.summary ?? "Permission gate", "NEEDS_APPROVAL");
      connectScope(graph, event, eventNodeId(event), "BLOCKS");
      break;
    case "decision_extracted":
      createDecision(graph, event);
      break;
    case "blocker_detected":
      createEventNode(graph, event, "BLOCKER", event.summary ?? "Blocker", "BLOCKED");
      connectScope(graph, event, eventNodeId(event), "BLOCKS");
      break;
    case "handoff_generated":
      createEventNode(graph, event, "HANDOFF", event.summary ?? "Handoff", "SUCCEEDED");
      connectScope(graph, event, eventNodeId(event), "PRODUCES");
      break;
    case "subagent_spawned":
      createEventNode(graph, event, "AGENT", event.summary ?? "Subagent", "ACTIVE");
      connectScope(graph, event, eventNodeId(event), "SPAWNS");
      break;
    case "git_status":
    case "git_commit":
    case "git_push":
      createEventNode(graph, event, "ARTIFACT", event.summary ?? event.kind, resultStatus(event));
      connectScope(graph, event, eventNodeId(event), "PRODUCES");
      break;
    default:
      createEventNode(graph, event, "ARTIFACT", event.summary ?? event.kind, "UNKNOWN");
      connectScope(graph, event, eventNodeId(event), "CONTAINS");
  }
}

function ensureSession(graph: MutableGraph, event: TraceEvent): void {
  const sessionId = sessionNodeId(event.sessionId);
  ensureNode(graph, {
    id: sessionId,
    type: "SESSION",
    label: event.sessionId,
    status: "ACTIVE",
    at: event.ts,
    eventId: event.id,
    data: { sessionId: event.sessionId, parentSessionId: event.parentSessionId ?? null },
    keepStatusIfExists: true
  });
  ensureEdge(graph, {
    from: runNodeId(event.runId),
    to: sessionId,
    type: "CONTAINS",
    at: event.ts,
    eventId: event.id
  });
}

function ensureAgent(graph: MutableGraph, event: TraceEvent): void {
  if (!event.agentId) {
    return;
  }
  const id = agentNodeId(event.agentId);
  ensureNode(graph, {
    id,
    type: "AGENT",
    // Identity stays the agentId (the dashboard matches lanes by it). A readable
    // display name rides in data.agentName, kept separate so matching never breaks.
    label: event.agentId,
    status: "ACTIVE",
    at: event.ts,
    eventId: event.id,
    // agentName is intentionally NOT set here: ensureNode merges data, so passing
    // it would let every event overwrite the name. The block below is the sole
    // authority — it fills/keeps the most concise label across all of the lane's
    // events.
    data: {
      agentId: event.agentId,
      agentRole: event.agentRole ?? "unknown"
    },
    keepStatusIfExists: true
  });
  // Resolve the display name. A lane can be labelled from two sources: the spawn
  // event (a concise role — `subagent_type`, `workflow:<name>`) and the subagent's
  // own transcript (its first prompt, a whole sentence). Prefer the concise one
  // regardless of arrival order: fill if empty, replace a generic placeholder, and
  // otherwise prefer a shorter non-generic label — so a 60-lane workflow reads as
  // roles, not walls of prompt text.
  if (event.agentLabel) {
    const node = graph.nodes.get(id);
    if (node) {
      const existing = typeof node.data.agentName === "string" ? node.data.agentName : "";
      const candidate = event.agentLabel;
      const generic = /^(subagent|agent|unknown)$/i;
      const better =
        existing.length === 0 ||
        generic.test(existing) ||
        (!generic.test(candidate) && candidate.length < existing.length);
      if (better) node.data.agentName = candidate;
    }
  }
  ensureEdge(graph, {
    from: sessionNodeId(event.sessionId),
    to: id,
    type: event.agentRole === "subagent" ? "SPAWNS" : "CONTAINS",
    at: event.ts,
    eventId: event.id
  });
}

function ensureTurn(graph: MutableGraph, event: TraceEvent): void {
  if (!event.turnId) {
    return;
  }
  const id = turnNodeId(event.turnId);
  ensureNode(graph, {
    id,
    type: "TURN",
    label: event.turnId,
    status: "ACTIVE",
    at: event.ts,
    eventId: event.id,
    data: { turnId: event.turnId },
    keepStatusIfExists: true
  });
  ensureEdge(graph, {
    from: event.agentId ? agentNodeId(event.agentId) : sessionNodeId(event.sessionId),
    to: id,
    type: "CONTAINS",
    at: event.ts,
    eventId: event.id
  });
}

function createEventNode(
  graph: MutableGraph,
  event: TraceEvent,
  type: WorkflowNodeType,
  label: string,
  status: WorkflowStatus
): void {
  ensureNode(graph, {
    id: eventNodeId(event),
    type,
    label,
    status,
    at: event.ts,
    eventId: event.id,
    data: { eventKind: event.kind, ...event.payload }
  });
}

function createFileActivity(graph: MutableGraph, event: TraceEvent): void {
  const path = filePathPayload(event) ?? "unknown-file";
  const fileId = fileNodeId(path);
  ensureNode(graph, {
    id: fileId,
    type: "FILE",
    label: path,
    status: event.kind === "file_deleted" ? "REVERTED" : "ACTIVE",
    at: event.ts,
    eventId: event.id,
    data: { path }
  });
  const edgeType = fileEdgeType(event.kind);
  connectScope(graph, event, fileId, edgeType);
}

function createDecision(graph: MutableGraph, event: TraceEvent): void {
  const label = stringPayload(event, "statement") ?? event.summary ?? "Decision";
  const decisionId = eventNodeId(event);
  createEventNode(graph, event, "DECISION", label, "SUCCEEDED");
  connectScope(graph, event, decisionId, "DECIDES");
  const evidenceIds = arrayPayload(event, "evidenceEventIds");
  for (const evidenceEventId of evidenceIds) {
    ensureEdge(graph, {
      from: eventNodeIdFromEventId(evidenceEventId),
      to: decisionId,
      type: "SUPPORTS_DECISION",
      at: event.ts,
      eventId: event.id,
      inferred: true,
      confidence: numberPayload(event, "confidence") ?? 0.5
    });
  }
}

function connectScope(
  graph: MutableGraph,
  event: TraceEvent,
  targetNodeId: string,
  edgeType: WorkflowEdgeType
): void {
  const sourceId = event.turnId
    ? turnNodeId(event.turnId)
    : event.agentId
      ? agentNodeId(event.agentId)
      : sessionNodeId(event.sessionId);
  ensureEdge(graph, {
    from: sourceId,
    to: targetNodeId,
    type: edgeType,
    at: event.ts,
    eventId: event.id
  });
}

function ensureNode(
  graph: MutableGraph,
  input: {
    id: string;
    type: WorkflowNodeType;
    label: string;
    status: WorkflowStatus;
    at: string;
    eventId?: string;
    data?: JsonObject;
    keepStatusIfExists?: boolean;
  }
): void {
  const existing = graph.nodes.get(input.id);
  if (existing) {
    existing.updatedAt = input.at;
    if (!input.keepStatusIfExists) {
      existing.status = input.status;
    }
    existing.data = { ...existing.data, ...(input.data ?? {}) };
    if (input.eventId && !existing.eventIds.includes(input.eventId)) {
      existing.eventIds.push(input.eventId);
    }
    return;
  }
  graph.nodes.set(input.id, {
    id: input.id,
    type: input.type,
    label: input.label,
    status: input.status,
    createdAt: input.at,
    updatedAt: input.at,
    eventIds: input.eventId ? [input.eventId] : [],
    data: input.data ?? {}
  });
}

function updateNodeStatus(graph: MutableGraph, nodeId: string, status: WorkflowStatus, event: TraceEvent): void {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    return;
  }
  node.status = status;
  node.updatedAt = event.ts;
  if (!node.eventIds.includes(event.id)) {
    node.eventIds.push(event.id);
  }
}

function ensureEdge(
  graph: MutableGraph,
  input: {
    from: string;
    to: string;
    type: WorkflowEdgeType;
    at: string;
    eventId: string;
    label?: string;
    inferred?: boolean;
    confidence?: number;
  }
): void {
  const id = workflowEdgeId(input.from, input.to, input.type);
  const existing = graph.edges.get(id);
  if (existing) {
    existing.updatedAt = input.at;
    if (!existing.eventIds.includes(input.eventId)) {
      existing.eventIds.push(input.eventId);
    }
    return;
  }
  graph.edges.set(id, {
    id,
    from: input.from,
    to: input.to,
    type: input.type,
    ...(input.label ? { label: input.label } : {}),
    createdAt: input.at,
    updatedAt: input.at,
    eventIds: [input.eventId],
    inferred: input.inferred ?? false,
    confidence: input.confidence ?? 1
  });
}

function freezeGraph(graph: MutableGraph): WorkflowGraph {
  return {
    runId: graph.runId,
    nodes: [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    appliedEventIds: [...graph.appliedEventIds]
  };
}

function sortEvents(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq || a.ts.localeCompare(b.ts));
}

function resultStatus(event: TraceEvent): WorkflowStatus {
  const exitCode = numberPayload(event, "exitCode");
  if (exitCode !== undefined) {
    return exitCode === 0 ? "SUCCEEDED" : "FAILED";
  }
  if (event.payload.error === true || typeof event.payload.error === "string") {
    return "FAILED";
  }
  return "SUCCEEDED";
}

function fileEdgeType(kind: TraceEvent["kind"]): WorkflowEdgeType {
  if (kind === "file_read") return "READS";
  if (kind === "file_edit") return "EDITS";
  if (kind === "file_created") return "CREATES";
  if (kind === "file_deleted") return "DELETES";
  return "UPDATES";
}

function messageLabel(event: TraceEvent): string {
  return stringPayload(event, "role") ? `Message: ${stringPayload(event, "role")}` : "Message";
}

function toolLabel(event: TraceEvent): string {
  return stringPayload(event, "tool") ?? stringPayload(event, "name") ?? "Tool call";
}

function commandLabel(event: TraceEvent): string {
  return stringPayload(event, "command") ?? "Command";
}

function searchLabel(event: TraceEvent): string {
  return stringPayload(event, "query") ?? "Search";
}

function stringPayload(event: TraceEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function stringPayloadPath(event: TraceEvent, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = payloadPath(event.payload, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function filePathPayload(event: TraceEvent): string | undefined {
  return stringPayloadPath(event, [
    "path",
    "file",
    "properties.file",
    "properties.path",
    "output.metadata.path",
    "input.args.filePath",
    "input.args.path"
  ]);
}

function payloadPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function numberPayload(event: TraceEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" ? value : undefined;
}

function arrayPayload(event: TraceEvent, key: string): string[] {
  const value = event.payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runNodeId(runId: string): string {
  return `run:${stablePart(runId)}`;
}

function sessionNodeId(sessionId: string): string {
  return `session:${stablePart(sessionId)}`;
}

function agentNodeId(agentId: string): string {
  return `agent:${stablePart(agentId)}`;
}

function turnNodeId(turnId: string): string {
  return `turn:${stablePart(turnId)}`;
}

function fileNodeId(path: string): string {
  return `file:${stablePart(path)}`;
}

function eventNodeId(event: TraceEvent): string {
  return eventNodeIdFromEventId(event.id);
}

function eventNodeIdFromEventId(eventId: string): string {
  return `event:${stablePart(eventId)}`;
}

function workflowEdgeId(from: string, to: string, type: WorkflowEdgeType): string {
  const enc = (s: string) => s.replace(/:/g, "__");
  return `edge:${type}:${enc(stablePart(from))}:${enc(stablePart(to))}`;
}

function stablePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
