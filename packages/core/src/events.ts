import type { JsonObject } from "./json.js";

export const traceHosts = [
  "opencode",
  "pi",
  "codex",
  "claude-code",
  "hermes",
  "custom"
] as const;

export type TraceHost = (typeof traceHosts)[number];

export const agentRoles = ["primary", "subagent", "system", "unknown"] as const;
export type AgentRole = (typeof agentRoles)[number];

export const traceEventKinds = [
  "session_created",
  "session_updated",
  "session_idle",
  "session_error",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message",
  "tool_call",
  "tool_result",
  "file_read",
  "file_edit",
  "file_created",
  "file_deleted",
  "search",
  "bash",
  "permission_asked",
  "permission_replied",
  "todo_updated",
  "subagent_spawned",
  "decision_extracted",
  "blocker_detected",
  "handoff_generated",
  "git_status",
  "git_commit",
  "git_push",
  "context_compacted",
  "command_run",
  "agent_switched",
  "model_switched",
  "host_event"
] as const;

export type TraceEventKind = (typeof traceEventKinds)[number];

export const dataSensitivities = [
  "public",
  "internal",
  "private",
  "secret",
  "student_sensitive"
] as const;

export type DataSensitivity = (typeof dataSensitivities)[number];

export type TraceEvidence = {
  observed: boolean;
  claimedByModel: boolean;
};

export type RedactionState = {
  rawStored: boolean;
  rulesApplied: string[];
  truncated: boolean;
};

export type TraceEvent = {
  id: string;
  ts: string;
  seq: number;
  host: TraceHost;
  runId: string;
  sessionId: string;
  parentSessionId?: string;
  // Absolute project directory the session ran in. Carried so the actuator can
  // write AGENTS.md to the *run's* project even when one daemon records many
  // projects (global recorder mode); absent on older traces.
  cwd?: string;
  agentId?: string;
  agentRole?: AgentRole;
  turnId?: string;
  kind: TraceEventKind;
  summary?: string;
  payload: JsonObject;
  sensitivity: DataSensitivity;
  redaction: RedactionState;
  evidence: TraceEvidence;
};

export type TraceEventInput = {
  ts?: string;
  host: TraceHost;
  runId: string;
  sessionId: string;
  parentSessionId?: string;
  cwd?: string;
  agentId?: string;
  agentRole?: AgentRole;
  turnId?: string;
  kind: TraceEventKind;
  summary?: string;
  payload?: JsonObject;
  sensitivity?: DataSensitivity;
  redaction?: Partial<RedactionState>;
  evidence?: Partial<TraceEvidence>;
};

export type EventValidationResult = {
  ok: boolean;
  errors: string[];
};

const observedKinds = new Set<TraceEventKind>([
  "tool_call",
  "tool_result",
  "file_read",
  "file_edit",
  "file_created",
  "file_deleted",
  "search",
  "bash",
  "permission_asked",
  "permission_replied",
  "todo_updated",
  "git_status",
  "git_commit",
  "git_push"
]);

const claimKinds = new Set<TraceEventKind>(["message", "decision_extracted", "handoff_generated"]);

export function createTraceEvent(seq: number, input: TraceEventInput): TraceEvent {
  const id = makeTraceEventId(input.runId, seq);
  const evidence = inferEvidence(input.kind, input.evidence);
  return {
    id,
    ts: input.ts ?? new Date().toISOString(),
    seq,
    host: input.host,
    runId: input.runId,
    sessionId: input.sessionId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.agentRole ? { agentRole: input.agentRole } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    kind: input.kind,
    ...(input.summary ? { summary: input.summary } : {}),
    payload: input.payload ?? {},
    sensitivity: input.sensitivity ?? "private",
    redaction: {
      rawStored: input.redaction?.rawStored ?? false,
      rulesApplied: input.redaction?.rulesApplied ?? [],
      truncated: input.redaction?.truncated ?? false
    },
    evidence
  };
}

export function makeTraceEventId(runId: string, seq: number): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `evt_${safeRunId}_${String(seq).padStart(6, "0")}`;
}

export function createEventSequencer(defaults: Omit<TraceEventInput, "kind">) {
  let seq = 0;
  return {
    next(input: Omit<TraceEventInput, "host" | "runId" | "sessionId">): TraceEvent {
      seq += 1;
      return createTraceEvent(seq, { ...defaults, ...input });
    },
    currentSeq(): number {
      return seq;
    }
  };
}

export function validateTraceEvent(event: unknown): EventValidationResult {
  const errors: string[] = [];
  if (!isRecord(event)) {
    return { ok: false, errors: ["event must be an object"] };
  }
  requireString(event, "id", errors);
  requireString(event, "ts", errors);
  requireNumber(event, "seq", errors);
  requireEnum(event, "host", traceHosts, errors);
  requireString(event, "runId", errors);
  requireString(event, "sessionId", errors);
  if (event.cwd !== undefined && typeof event.cwd !== "string") {
    errors.push("cwd must be a string when present");
  }
  requireEnum(event, "kind", traceEventKinds, errors);
  requireEnum(event, "sensitivity", dataSensitivities, errors);
  if (!isRecord(event.payload)) {
    errors.push("payload must be an object");
  }
  if (!isRecord(event.redaction)) {
    errors.push("redaction must be an object");
  }
  if (!isRecord(event.evidence)) {
    errors.push("evidence must be an object");
  }
  if (typeof event.ts === "string" && Number.isNaN(Date.parse(event.ts))) {
    errors.push("ts must be an ISO-compatible timestamp");
  }
  if (typeof event.seq === "number" && (!Number.isInteger(event.seq) || event.seq < 1)) {
    errors.push("seq must be a positive integer");
  }
  return { ok: errors.length === 0, errors };
}

export function assertTraceEvent(event: unknown): asserts event is TraceEvent {
  const result = validateTraceEvent(event);
  if (!result.ok) {
    throw new Error(`Invalid trace event: ${result.errors.join("; ")}`);
  }
}

function inferEvidence(kind: TraceEventKind, override: Partial<TraceEvidence> | undefined): TraceEvidence {
  return {
    observed: override?.observed ?? observedKinds.has(kind),
    claimedByModel: override?.claimedByModel ?? claimKinds.has(kind)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof value[key] !== "string" || value[key] === "") {
    errors.push(`${key} must be a non-empty string`);
  }
}

function requireNumber(value: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof value[key] !== "number") {
    errors.push(`${key} must be a number`);
  }
}

function requireEnum<T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  allowed: T,
  errors: string[]
): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as T[number])) {
    errors.push(`${key} must be one of ${allowed.join(", ")}`);
  }
}

