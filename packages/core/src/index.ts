export const AGENT_BLACKBOX_CORE_VERSION = "0.1.0";

export function describeCore(): string {
  return "Agent-Blackbox core: canonical events, workflow graph, redaction, and replay.";
}

export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export { isJsonObject } from "./json.js";
export type {
  AgentRole,
  DataSensitivity,
  EventValidationResult,
  RedactionState,
  TraceEvent,
  TraceEventInput,
  TraceEventKind,
  TraceEvidence,
  TraceHost
} from "./events.js";
export {
  agentRoles,
  assertTraceEvent,
  createEventSequencer,
  createTraceEvent,
  dataSensitivities,
  makeTraceEventId,
  traceEventKinds,
  traceHosts,
  validateTraceEvent
} from "./events.js";
export type { RedactionOptions, RedactionResult, RedactionRule } from "./redaction.js";
export { defaultRedactionRules, redactJsonObject, redactJsonValue } from "./redaction.js";
export type {
  GraphDiff,
  WorkflowEdge,
  WorkflowEdgeType,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowStatus
} from "./graph.js";
export {
  diffWorkflowGraphs,
  materializeWorkflowGraph,
  replayWorkflowGraphAtSeq,
  replayWorkflowGraphAtTime,
  workflowEdgeTypes,
  workflowNodeTypes,
  workflowStatuses
} from "./graph.js";
export type { PromiseCheck, PromiseCheckSeverity, PromiseCheckStatus } from "./audit.js";
export { evaluatePromiseChecks, generateHandoffMarkdown } from "./audit.js";
