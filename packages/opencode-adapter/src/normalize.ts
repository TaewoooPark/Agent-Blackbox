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
  const payload = normalizePayload(minimizeOpenCodeEventPayload(raw, type), context);
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

function minimizeOpenCodeEventPayload(raw: UnknownRecord, type: string): JsonObject {
  if (!type.startsWith("message.")) {
    return toJsonObject(raw);
  }

  const properties = asRecord(raw.properties);
  const info = asRecord(properties.info);
  const part = asRecord(properties.part);
  const state = asRecord(part.state);
  return compactJsonObject({
    id: readString(raw, ["id"]),
    type,
    properties: compactJsonObject({
      sessionID:
        readString(properties, ["sessionID"]) ??
        readString(info, ["sessionID"]) ??
        readString(part, ["sessionID"]),
      messageID: readString(properties, ["messageID"]) ?? readString(info, ["id"]) ?? readString(part, ["messageID"]),
      role: readString(info, ["role"]),
      agent: readString(info, ["agent"]),
      modelID: readString(info, ["modelID", "model.modelID"]),
      field: readString(properties, ["field"]),
      deltaLength: readString(properties, ["delta"])?.length,
      part: compactJsonObject({
        id: readString(part, ["id"]),
        type: readString(part, ["type"]),
        tool: readString(part, ["tool"]),
        callID: readString(part, ["callID"]),
        stateStatus: readString(state, ["status"])
      })
    })
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
  const tool = readString(input, ["tool", "name"]) ?? readString(output, ["tool", "name"]) ?? "unknown-tool";
  const payload = normalizePayload(
    {
      phase: "after",
      tool,
      input,
      output
    },
    context
  );
  const observed = deriveObservedToolResult(tool, payload.value);
  const traceInput: TraceEventInput = {
    host: "opencode",
    runId: context.runId,
    sessionId: extractSessionId(input, context.defaultSessionId),
    kind: observed?.kind ?? "tool_result",
    summary: observed?.summary ?? `tool.after:${payload.value.tool ?? "unknown-tool"}`,
    payload: observed?.payload ?? payload.value,
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

function deriveObservedToolResult(
  tool: string,
  payload: JsonObject
): { kind: TraceEventKind; summary: string; payload: JsonObject } | undefined {
  if (tool === "read") {
    const path =
      readString(payload, ["input.args.filePath", "output.metadata.display.path"]) ??
      readString(payload, ["output.title"]);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      path,
      callID: readString(payload, ["input.callID"]),
      preview: readString(payload, ["output.metadata.preview"]),
      truncated: readBoolean(payload, ["output.metadata.truncated"])
    });
    return {
      kind: "file_read",
      summary: path ? `Read ${path}` : "Read file",
      payload: observedPayload
    };
  }

  if (tool === "bash") {
    const command = readString(payload, ["input.args.command", "output.metadata.command"]);
    const exitCode = readNumber(payload, ["output.metadata.exit", "output.metadata.exitCode"]);
    const outputPreview = shortenOptional(readString(payload, ["output.metadata.output", "output.output"]), 1200);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      command,
      exitCode,
      description: readString(payload, ["input.args.description", "output.metadata.description"]),
      outputPreview,
      truncated: readBoolean(payload, ["output.metadata.truncated"])
    });
    return {
      kind: "bash",
      summary: command ? `Ran ${command}` : "Ran shell command",
      payload: observedPayload
    };
  }

  if (tool === "edit" || tool === "write" || tool === "patch") {
    const path = readString(payload, ["input.args.filePath", "input.args.path", "output.metadata.path"]);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      path,
      callID: readString(payload, ["input.callID"])
    });
    return {
      kind: tool === "write" ? "file_created" : "file_edit",
      summary: path ? `Edited ${path}` : "Edited file",
      payload: observedPayload
    };
  }

  return undefined;
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

function readNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function readBoolean(record: UnknownRecord, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "boolean") {
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

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "undefined") {
      continue;
    }
    output[key] = sanitizeJson(value, new WeakSet<object>()) as JsonObject[keyof JsonObject];
  }
  return output;
}

function shortenOptional(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
