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

/**
 * OpenCode publishes a broad internal event bus. These types carry no
 * operational signal for the trace graph and arrive in high volume, so the
 * recorder drops them before they consume a sequence number:
 *  - `message.part.delta`: per-token streaming chunks (the resulting message is
 *    still captured via `message.updated` / `message.part.updated`).
 *  - registry/lifecycle chatter emitted mostly at startup.
 *  - `tui.*`: terminal-UI chrome (toasts, prompts). Multi-agent harnesses such
 *    as oh-my-openagent fire `tui.toast.show` heavily for status babysitting;
 *    these are session-less UI events with no trace signal.
 */
const ignoredEventTypes = new Set<string>([
  "message.part.delta",
  "catalog.updated",
  "plugin.added",
  "plugin.removed",
  "integration.updated",
  "installation.updated",
  "reference.updated"
]);

const ignoredEventPrefixes = ["tui."];

export function shouldRecordOpenCodeEvent(rawEvent: unknown): boolean {
  const type = readString(asRecord(rawEvent), ["type"]);
  if (!type) return true;
  if (ignoredEventTypes.has(type)) return false;
  return !ignoredEventPrefixes.some((prefix) => type.startsWith(prefix));
}

// A subagent's session is announced by a `session.created` whose info carries a
// parentID. Returns that linkage so the recorder can attribute every later
// event in the session to the subagent that owns it.
export function subagentSessionFromEvent(
  rawEvent: unknown
): { sessionId: string; agent: string; parentId: string } | null {
  const raw = asRecord(rawEvent);
  if (readString(raw, ["type"]) !== "session.created") return null;
  const properties = asRecord(raw.properties);
  const info = asRecord(properties.info);
  const parentId = readString(info, ["parentID", "parentId"]);
  const sessionId = readString(info, ["id"]) ?? readString(properties, ["sessionID", "sessionId"]);
  if (!parentId || !sessionId) return null;
  const agent =
    readString(info, ["agent"]) ??
    agentFromSubagentTitle(readString(info, ["title"])) ??
    "subagent";
  return { agent, parentId, sessionId };
}

// Harnesses that spawn child sessions via the SDK (rather than naming the agent
// on the session info) encode it in the session title, e.g. oh-my-openagent's
// `"Research documentation (@librarian subagent)"`. Recover that name so each
// lane shows the real specialist (explore, librarian, oracle, …) instead of a
// generic "subagent".
export function agentFromSubagentTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const match = title.match(/@([A-Za-z0-9][\w-]*)/);
  return match ? match[1] : undefined;
}

export function normalizeOpenCodeEvent(rawEvent: unknown, context: OpenCodeNormalizerContext): TraceEvent {
  const raw = asRecord(rawEvent);
  const type = readString(raw, ["type"]) ?? "unknown";
  const kind = eventKindMap[type] ?? "session_updated";
  const payload = normalizePayload(minimizeOpenCodeEventPayload(raw, type), context);
  const sessionId = extractSessionId(raw, context.defaultSessionId);
  const agentId = extractAgentId(raw);
  const agentRole = extractAgentRole(raw);
  return createTraceEvent(context.seq, {
    host: "opencode",
    runId: context.runId,
    sessionId,
    ...(agentId ? { agentId } : {}),
    ...(agentId ? { agentRole } : {}),
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

export function normalizeSyntheticUserPrompt(
  prompt: string,
  sourceEvent: TraceEvent,
  context: OpenCodeNormalizerContext
): TraceEvent {
  const payload = normalizePayload(
    {
      type: "opencode.run.prompt",
      properties: {
        sessionID: sourceEvent.sessionId,
        role: "user",
        text: stripWrappingQuotes(prompt)
      }
    },
    context
  );
  return createTraceEvent(context.seq, {
    host: "opencode",
    runId: context.runId,
    sessionId: sourceEvent.sessionId,
    kind: "message",
    summary: "opencode.run.prompt",
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
  const role = readString(info, ["role"]) ?? readString(properties, ["role"]);
  const userText = role === "user" ? shortenOptional(readMessageText(properties, info, part), 2000) : undefined;
  return compactJsonObject({
    id: readString(raw, ["id"]),
    type,
    properties: compactJsonObject({
      sessionID:
        readString(properties, ["sessionID"]) ??
        readString(info, ["sessionID"]) ??
        readString(part, ["sessionID"]),
      messageID: readString(properties, ["messageID"]) ?? readString(info, ["id"]) ?? readString(part, ["messageID"]),
      role,
      agent: readString(info, ["agent"]),
      modelID: readString(info, ["modelID", "model.modelID"]),
      text: userText,
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
  if (observed?.kind === "subagent_spawned") {
    // Attribute the spawn to the subagent it launched, so the workflow tree
    // forks a branch labeled with that subagent rather than the parent agent.
    const subagentId = readString(observed.payload, ["agent"]);
    traceInput.agentId = subagentId ?? extractAgentId(input) ?? "subagent";
    traceInput.agentRole = "subagent";
  } else {
    const agentId = extractAgentId(input);
    if (agentId) {
      traceInput.agentId = agentId;
    }
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
    const size = measureContent(payload, ["output.output", "output.content", "output.metadata.preview"]);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      path,
      callID: readString(payload, ["input.callID"]),
      preview: readString(payload, ["output.metadata.preview"]),
      truncated: readBoolean(payload, ["output.metadata.truncated"]),
      chars: size?.chars,
      lines: size?.lines
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
    const size = measureContent(payload, ["output.metadata.output", "output.output"]);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      command,
      exitCode,
      description: readString(payload, ["input.args.description", "output.metadata.description"]),
      outputPreview,
      truncated: readBoolean(payload, ["output.metadata.truncated"]),
      outputChars: size?.chars,
      outputLines: size?.lines
    });
    return {
      kind: "bash",
      summary: command ? `Ran ${command}` : "Ran shell command",
      payload: observedPayload
    };
  }

  if (tool === "edit" || tool === "write" || tool === "patch") {
    const path = readString(payload, ["input.args.filePath", "input.args.path", "output.metadata.path"]);
    const size = measureContent(payload, [
      "input.args.content",
      "input.args.newString",
      "input.args.replacement",
      "input.args.patch"
    ]);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      path,
      callID: readString(payload, ["input.callID"]),
      chars: size?.chars,
      lines: size?.lines
    });
    return {
      kind: tool === "write" ? "file_created" : "file_edit",
      summary: path ? `Edited ${path}` : "Edited file",
      payload: observedPayload
    };
  }

  if (tool === "task") {
    const subagentType = readString(payload, ["input.args.subagent_type", "output.args.subagent_type"]);
    const description = readString(payload, ["input.args.description", "output.args.description"]);
    const observedPayload = compactJsonObject({
      tool,
      source: "tool.after",
      agent: subagentType,
      description,
      prompt: shortenOptional(readString(payload, ["input.args.prompt", "output.args.prompt"]), 600),
      callID: readString(payload, ["input.callID"])
    });
    return {
      kind: "subagent_spawned",
      summary: subagentType ? `Delegated to ${subagentType} subagent` : "Delegated to a subagent",
      payload: observedPayload
    };
  }

  if (tool === "skill") {
    const name = readString(payload, ["input.args.name", "output.args.name"]);
    const size = measureContent(payload, ["output.output", "output.content"]);
    return {
      kind: "tool_result",
      summary: name ? `Used the ${name} skill` : "Used a skill",
      payload: compactJsonObject({
        tool: "skill",
        source: "tool.after",
        skill: name,
        title: readString(payload, ["output.title"]),
        callID: readString(payload, ["input.callID"]),
        outputChars: size?.chars,
        outputLines: size?.lines
      })
    };
  }

  // Any other tool (grep, glob, list, webfetch, todowrite, a command, …) is
  // still a real action — keep it as a renderable result instead of dropping it.
  const size = measureContent(payload, ["output.output", "output.content", "output.metadata.output"]);
  return {
    kind: "tool_result",
    summary: `Used ${tool}`,
    payload: compactJsonObject({
      tool,
      source: "tool.after",
      title: readString(payload, ["output.title"]),
      description: readString(payload, ["input.args.description", "output.metadata.description"]),
      callID: readString(payload, ["input.callID"]),
      outputChars: size?.chars,
      outputLines: size?.lines
    })
  };
}

function readMessageText(...records: UnknownRecord[]): string | undefined {
  for (const record of records) {
    const direct = readString(record, ["text", "content", "prompt", "message"]);
    if (direct) {
      return direct;
    }

    const parts = readPath(record, "parts");
    if (Array.isArray(parts)) {
      const text = parts
        .map((part) => {
          if (!isRecord(part)) return undefined;
          return readString(part, ["text", "content"]);
        })
        .filter((part): part is string => Boolean(part))
        .join("\n")
        .trim();
      if (text.length > 0) {
        return text;
      }
    }
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
  const properties = asRecord(raw.properties);
  return (
    readString(raw, ["sessionID", "sessionId", "session.id"]) ??
    readString(properties, ["sessionID", "sessionId", "session.id"]) ??
    readString(asRecord(properties.info), ["sessionID", "sessionId"]) ??
    readString(asRecord(properties.part), ["sessionID", "sessionId"]) ??
    readString(asRecord(raw.event), ["sessionID", "sessionId", "session.id"]) ??
    fallback
  );
}

function extractAgentId(raw: UnknownRecord): string | undefined {
  const properties = asRecord(raw.properties);
  const info = asRecord(properties.info);
  return (
    readString(raw, ["agentID", "agentId", "agent.id", "agent.name"]) ??
    readString(properties, ["agentID", "agentId", "agent.id", "agent.name", "agent"]) ??
    readString(info, ["agentID", "agentId", "agent.id", "agent.name", "agent"]) ??
    readString(asRecord(raw.event), ["agentID", "agentId", "agent.id", "agent.name", "agent"])
  );
}

function extractAgentRole(raw: UnknownRecord): "primary" | "subagent" | "system" | "unknown" {
  const role =
    readString(raw, ["agentRole", "agent.role"]) ??
    readString(asRecord(raw.properties), ["agentRole", "agent.role"]) ??
    readString(asRecord(asRecord(raw.properties).info), ["agentRole", "agent.role"]);
  if (role === "subagent" || role === "system" || role === "unknown") return role;
  return "primary";
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
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

// Measure how much text a tool moved into / out of context WITHOUT storing the
// text — only the counts survive, so redaction is unaffected while the context
// efficiency engine can still see how many chars/lines each read, output, or
// edit added. Picks the longest candidate so a full body beats a truncated
// preview when both are present.
function measureContent(record: UnknownRecord, paths: string[]): { chars: number; lines: number } | undefined {
  let longest: string | undefined;
  for (const path of paths) {
    const value = readPath(record, path);
    if (typeof value === "string" && (longest === undefined || value.length > longest.length)) {
      longest = value;
    }
  }
  if (longest === undefined) {
    return undefined;
  }
  return { chars: longest.length, lines: longest.split("\n").length };
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
