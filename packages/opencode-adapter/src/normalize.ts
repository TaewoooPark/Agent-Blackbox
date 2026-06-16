import {
  createTraceEvent,
  redactJsonObject,
  type JsonObject,
  type TraceEvent,
  type TraceEventInput,
  type TraceEventKind
} from "@agent-blackbox/core";
import type { OpenCodeHookInput, OpenCodeHookOutput, UnknownRecord } from "./types.js";

export type OpenCodeNormalizerContext = {
  runId: string;
  seq: number;
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
};

const eventKindMap: Record<string, TraceEventKind> = {
  "session.created": "session_created",
  "session.updated": "session_updated",
  "session.status": "session_updated",
  "session.idle": "session_idle",
  "session.error": "session_error",
  "message.updated": "message",
  "message.removed": "message",
  "message.part.updated": "message",
  "message.part.removed": "message",
  "file.edited": "file_edit",
  "command.executed": "bash",
  "permission.asked": "permission_asked",
  "permission.replied": "permission_replied",
  "todo.updated": "todo_updated"
};

export function normalizeOpenCodeEvent(rawEvent: unknown, context: OpenCodeNormalizerContext): TraceEvent {
  const raw = asRecord(rawEvent);
  const type = readString(raw, ["type"]) ?? "unknown";
  const kind = eventKindMap[type] ?? "session_updated";
  const payload = normalizePayload(raw, context);
  const sessionId = extractSessionId(raw, context.defaultSessionId);
  const agentId = extractAgentId(raw);
  return createTraceEvent(context.seq, {
    host: "opencode",
    runId: context.runId,
    sessionId,
    ...(agentId ? { agentId } : {}),
    kind,
    summary: type,
    payload: payload.value,
    redaction: {
      rawStored: context.rawStored ?? false,
      rulesApplied: payload.rulesApplied,
      truncated: payload.truncated
    }
  });
}

export function normalizeToolBefore(
  input: OpenCodeHookInput,
  output: OpenCodeHookOutput,
  context: OpenCodeNormalizerContext
): TraceEvent {
  const payload = normalizePayload(
    {
      phase: "before",
      tool: readString(input, ["tool", "name"]) ?? readString(output, ["tool", "name"]) ?? "unknown-tool",
      input,
      output
    },
    context
  );
  const traceInput: TraceEventInput = {
    host: "opencode",
    runId: context.runId,
    sessionId: extractSessionId(input, context.defaultSessionId),
    kind: "tool_call",
    summary: `tool.before:${payload.value.tool ?? "unknown-tool"}`,
    payload: payload.value,
    redaction: {
      rawStored: context.rawStored ?? false,
      rulesApplied: payload.rulesApplied,
      truncated: payload.truncated
    }
  };
  const agentId = extractAgentId(input);
  if (agentId) {
    traceInput.agentId = agentId;
  }
  return createTraceEvent(context.seq, traceInput);
}

export function normalizeToolAfter(
  input: OpenCodeHookInput,
  output: OpenCodeHookOutput,
  context: OpenCodeNormalizerContext
): TraceEvent {
  const payload = normalizePayload(
    {
      phase: "after",
      tool: readString(input, ["tool", "name"]) ?? readString(output, ["tool", "name"]) ?? "unknown-tool",
      input,
      output
    },
    context
  );
  const traceInput: TraceEventInput = {
    host: "opencode",
    runId: context.runId,
    sessionId: extractSessionId(input, context.defaultSessionId),
    kind: "tool_result",
    summary: `tool.after:${payload.value.tool ?? "unknown-tool"}`,
    payload: payload.value,
    redaction: {
      rawStored: context.rawStored ?? false,
      rulesApplied: payload.rulesApplied,
      truncated: payload.truncated
    }
  };
  const agentId = extractAgentId(input);
  if (agentId) {
    traceInput.agentId = agentId;
  }
  return createTraceEvent(context.seq, traceInput);
}

function normalizePayload(value: unknown, context: OpenCodeNormalizerContext) {
  return redactJsonObject(toJsonObject(value), {
    ...(context.homeDir ? { homeDir: context.homeDir } : {}),
    ...(context.projectDir ? { projectDir: context.projectDir } : {}),
    maxStringLength: 4000
  });
}

function toJsonObject(value: unknown): JsonObject {
  return sanitizeJson(value, new WeakSet<object>()) as JsonObject;
}

function sanitizeJson(value: unknown, seen: WeakSet<object>): JsonObject | JsonObject[keyof JsonObject] {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((item) => sanitizeJson(item, seen)) as JsonObject[keyof JsonObject];
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const output: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "undefined" || typeof nested === "function" || typeof nested === "symbol") {
        continue;
      }
      output[key] = sanitizeJson(nested, seen);
    }
    return output;
  }
  return String(value);
}

function extractSessionId(raw: UnknownRecord, fallback: string): string {
  return (
    readString(raw, ["sessionID", "sessionId", "session.id", "sessionID"]) ??
    readString(asRecord(raw.event), ["sessionID", "sessionId", "session.id"]) ??
    fallback
  );
}

function extractAgentId(raw: UnknownRecord): string | undefined {
  return (
    readString(raw, ["agentID", "agentId", "agent.id", "agent.name"]) ??
    readString(asRecord(raw.event), ["agentID", "agentId", "agent.id", "agent.name"])
  );
}

function readString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readPath(record: UnknownRecord, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
