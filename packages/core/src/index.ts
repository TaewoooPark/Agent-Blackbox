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
export type { EfficiencyMetric, EfficiencyOptions, EfficiencyReport, EfficiencyStatus, Suggestion } from "./efficiency.js";
export { buildDeterministicSuggestions, computeEfficiencyReport } from "./efficiency.js";
export type { ArchetypeProfile, RunClassification, TaskArchetype } from "./taskProfile.js";
export { ARCHETYPE_PROFILES, classifyRun, taskArchetypes } from "./taskProfile.js";
export type {
  EffectivenessConfidence,
  EffectivenessReport,
  EffectivenessSignal,
  EffectivenessStatus
} from "./effectiveness.js";
export { computeEffectiveness } from "./effectiveness.js";
export type { BaselineComparison, RunSummary } from "./baseline.js";
export { BASELINE_MAX_HISTORY, compareToBaseline, upsertRunSummary } from "./baseline.js";
export type { EfficiencyMemoryOptions } from "./efficiencyMemory.js";
export {
  buildEfficiencyMemory,
  EFFICIENCY_MEMORY_END,
  EFFICIENCY_MEMORY_START,
  hasManagedBlock,
  removeManagedBlock,
  upsertManagedBlock
} from "./efficiencyMemory.js";
