import {
  redactJsonObject,
  redactJsonValue,
  roleFromPrompt,
  type JsonObject,
  type TraceEventInput
} from "@agent-blackbox/core";
import type { GjcNormalizerContext, GjcTranscriptLine, UnknownRecord } from "./types.js";

const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "applypatch", "apply_patch", "notebookedit"]);
const WRITE_TOOLS = new Set(["write"]);
const BASH_TOOLS = new Set(["bash", "shell"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "ls", "search", "web_search", "websearch", "find"]);
const SUBAGENT_TOOLS = new Set(["task", "agent"]);
const TODO_TOOLS = new Set(["todo_write", "todowrite", "taskcreate", "taskupdate", "taskstop"]);
const COMMAND_TOOLS = new Set(["skill"]);

export function createGjcNormalizer(ctx: GjcNormalizerContext) {
  const toolUses = new Map<string, { name: string; input: JsonObject }>();
  let lastModel: string | undefined;

  const consume = (rawLine: GjcTranscriptLine): TraceEventInput[] => {
    const line = asRecord(rawLine);
    switch (readString(line, ["type"])) {
      case "session":
        return [mkInput(line, ctx, { kind: "session_created", summary: "Gajae-Code session", payload: { version: readNumber(line, ["version"]) ?? 0 } })];
      case "model_change": {
        const model = readString(line, ["model"]);
        if (!model || model === lastModel) return [];
        lastModel = model;
        return [mkInput(line, ctx, { kind: "model_switched", summary: `Model → ${model}`, payload: { model } })];
      }
      case "message":
        return consumeMessage(line, ctx, toolUses);
      case "custom_message":
        return consumeCustomMessage(line, ctx);
      case "tool_call":
        return consumeDirectToolCall(line, ctx, toolUses);
      case "tool_result":
        return consumeDirectToolResult(line, ctx, toolUses);
      case "compaction":
      case "compact_boundary":
        return [mkInput(line, ctx, { kind: "context_compacted", summary: "Context compacted", payload: {} })];
      default:
        return consumeUnknown(line, ctx);
    }
  };

  return { consume };
}

function consumeMessage(line: UnknownRecord, ctx: GjcNormalizerContext, toolUses: Map<string, { name: string; input: JsonObject }>): TraceEventInput[] {
  const msg = asRecord(line.message);
  const role = readString(msg, ["role"]);
  const events: TraceEventInput[] = [];

  if (ctx.agent && !ctx.agent.label && role === "user") {
    const label = extractText(msg.content);
    if (label) ctx.agent.label = shortLabel(label);
  }

  if ((role === "user" || role === "assistant") && !hasToolOnlyContent(msg.content)) {
    const text = extractText(msg.content);
    if (text) events.push(mkInput(line, ctx, { kind: "message", summary: `${role} message`, payload: { role, chars: text.length } }));
  }

  const usage = asRecord(msg.usage);
  if (role === "assistant" && Object.keys(usage).length > 0) {
    events.push(
      mkInput(line, ctx, {
        kind: "message",
        summary: "assistant turn",
        payload: {
          role: "assistant",
          tokens: {
            input: num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
            output: num(usage.output_tokens),
            cache: { read: num(usage.cache_read_input_tokens), write: num(usage.cache_creation_input_tokens) }
          }
        }
      })
    );
  }

  for (const block of asArray(msg.content)) {
    const b = asRecord(block);
    const blockType = readString(b, ["type"]);
    if (blockType === "toolCall" || blockType === "tool_call" || blockType === "tool_use") {
      const id = readString(b, ["id", "toolCallId", "callID"]);
      const name = readString(b, ["name", "toolName"]) ?? "unknown-tool";
      const input = asJsonObject(b.arguments ?? b.input);
      if (id) toolUses.set(id, { name, input });
      events.push(mkInput(line, ctx, { kind: "tool_call", summary: `tool.call:${prettyTool(name)}`, payload: { tool: name, ...(id ? { callID: id } : {}) } }));
    }
    if (blockType === "toolResult" || blockType === "tool_result") {
      const id = readString(b, ["toolCallId", "tool_use_id", "id"]);
      const call = id ? toolUses.get(id) : undefined;
      const result = call ? deriveObserved(call.name, call.input, b, line, ctx) : undefined;
      if (result) events.push(result);
    }
  }

  return events;
}

function consumeCustomMessage(line: UnknownRecord, ctx: GjcNormalizerContext): TraceEventInput[] {
  const customType = readString(line, ["customType"]);
  if (customType === "skill-prompt") {
    return [mkInput(line, ctx, { kind: "command_run", summary: "Skill prompt", payload: { command: "skill" } })];
  }
  return [mkInput(line, ctx, { kind: "host_event", summary: customType ? `GJC ${customType}` : "GJC custom message", payload: { ...(customType ? { customType } : {}) } })];
}

function consumeDirectToolCall(line: UnknownRecord, ctx: GjcNormalizerContext, toolUses: Map<string, { name: string; input: JsonObject }>): TraceEventInput[] {
  const id = readString(line, ["id", "toolCallId", "callID"]);
  const name = readString(line, ["name", "toolName"]) ?? "unknown-tool";
  const input = asJsonObject(line.arguments ?? line.input);
  if (id) toolUses.set(id, { name, input });
  return [mkInput(line, ctx, { kind: "tool_call", summary: `tool.call:${prettyTool(name)}`, payload: { tool: name, ...(id ? { callID: id } : {}) } })];
}

function consumeDirectToolResult(line: UnknownRecord, ctx: GjcNormalizerContext, toolUses: Map<string, { name: string; input: JsonObject }>): TraceEventInput[] {
  const id = readString(line, ["toolCallId", "tool_use_id", "id"]);
  const call = id ? toolUses.get(id) : undefined;
  const name = call?.name ?? readString(line, ["name", "toolName"]);
  if (!name) return [];
  const input = call?.input ?? asJsonObject(line.arguments ?? line.input);
  const result = deriveObserved(name, input, line, line, ctx);
  return result ? [result] : [];
}

function consumeUnknown(line: UnknownRecord, ctx: GjcNormalizerContext): TraceEventInput[] {
  const type = readString(line, ["type"]);
  if (!type) return [];
  if (type === "thinking_level_change") return [];
  return [mkInput(line, ctx, { kind: "host_event", summary: `GJC ${type}`, payload: { event: type } })];
}

function deriveObserved(name: string, input: JsonObject, result: UnknownRecord, line: UnknownRecord, ctx: GjcNormalizerContext): TraceEventInput | undefined {
  const lname = name.toLowerCase();
  const isError = result.isError === true || result.is_error === true;
  const output = asRecord(result.output ?? result.result ?? result.details);

  if (READ_TOOLS.has(lname)) {
    const path = readString(output, ["filePath", "path"]) ?? readString(input, ["path", "file_path"]);
    const chars = strlen(output.content) ?? strlen(result.content) ?? measureText(result);
    return mkInput(line, ctx, { kind: "file_read", summary: path ? `Read ${path}` : "Read file", payload: { ...(path ? { path } : {}), ...(chars !== undefined ? { chars } : {}) } });
  }

  if (EDIT_TOOLS.has(lname)) {
    const path = readString(output, ["filePath", "path"]) ?? readString(input, ["path", "file_path"]);
    const chars = strlen(output.newString) ?? strlen(input.new_string) ?? strlen(input.replacement) ?? measureText(result);
    return mkInput(line, ctx, { kind: "file_edit", summary: path ? `Edited ${path}` : "Edited file", payload: { ...(path ? { path } : {}), ...(chars !== undefined ? { chars } : {}) } });
  }

  if (WRITE_TOOLS.has(lname)) {
    const path = readString(output, ["filePath", "path"]) ?? readString(input, ["path", "file_path"]);
    const chars = strlen(input.content) ?? strlen(output.content) ?? measureText(result);
    return mkInput(line, ctx, { kind: "file_created", summary: path ? `Created ${path}` : "Created file", payload: { ...(path ? { path } : {}), ...(chars !== undefined ? { chars } : {}) } });
  }

  if (BASH_TOOLS.has(lname)) {
    const command = readString(input, ["command"]);
    const outputChars = (strlen(output.stdout) ?? 0) + (strlen(output.stderr) ?? 0) || measureText(result) || 0;
    const git = command ? gitKind(command) : undefined;
    if (git) return mkInput(line, ctx, { kind: git.kind, summary: isError ? `${git.label} (failed)` : git.label, payload: { ...(command ? { command } : {}), exitCode: isError ? 1 : 0, outputChars } });
    return mkInput(line, ctx, { kind: "bash", summary: command ? `Ran ${command}` : "Ran shell command", payload: { ...(command ? { command } : {}), exitCode: isError ? 1 : 0, outputChars } });
  }

  if (SEARCH_TOOLS.has(lname)) {
    const query = readString(input, ["pattern", "query", "glob", "path"]);
    return mkInput(line, ctx, { kind: "search", summary: query ? `Searched ${query}` : "Searched", payload: { ...(query ? { query } : {}) } });
  }

  if (SUBAGENT_TOOLS.has(lname)) {
    const label = readString(input, ["agent", "subagent_type", "description"]) ?? "subagent";
    const agentId = readString(output, ["agentId", "id"]);
    const ev = mkInput(line, ctx, { kind: "subagent_spawned", summary: `Delegated to ${label}`, payload: { agent: label, ...(agentId ? { agentId } : {}) } });
    ev.agentId = agentId ? safeLaneField(agentId, ctx) : "subagent";
    ev.agentRole = "subagent";
    ev.agentLabel = safeLaneField(label, ctx);
    return ev;
  }

  if (TODO_TOOLS.has(lname)) return mkInput(line, ctx, { kind: "todo_updated", summary: "Updated todos", payload: {} });
  if (COMMAND_TOOLS.has(lname)) {
    const command = readString(input, ["name", "skill", "command"]) ?? "skill";
    return mkInput(line, ctx, { kind: "command_run", summary: `/${command}`, payload: { command } });
  }

  return mkInput(line, ctx, { kind: "tool_result", summary: `Used ${prettyTool(name)}`, payload: { tool: name, ...(measureText(result) !== undefined ? { outputChars: measureText(result) } : {}) } });
}

function mkInput(line: UnknownRecord, ctx: GjcNormalizerContext, partial: { kind: TraceEventInput["kind"]; summary: string; payload: Record<string, unknown> }): TraceEventInput {
  const redactOpts = { ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}), ...(ctx.projectDir ? { projectDir: ctx.projectDir } : {}), maxStringLength: 4000 };
  const redacted = redactJsonObject(sanitize(partial.payload), redactOpts);
  const summary = redactJsonValue(partial.summary, redactOpts).value;
  const sessionId = readString(line, ["sessionId"]) ?? ctx.defaultSessionId;
  const ts = readString(line, ["timestamp"]);
  const cwd = readString(line, ["cwd"]);
  const input: TraceEventInput = {
    host: "gjc",
    runId: sessionId,
    sessionId,
    kind: partial.kind,
    summary,
    payload: redacted.value,
    redaction: { rawStored: ctx.rawStored ?? false, rulesApplied: redacted.rulesApplied, truncated: redacted.truncated }
  };
  if (ts) input.ts = ts;
  if (cwd) input.cwd = redactJsonValue(cwd, redactOpts).value;
  if (ctx.agent) {
    input.agentId = ctx.agent.agentId;
    input.agentRole = "subagent";
    if (ctx.agent.label) input.agentLabel = redactJsonValue(ctx.agent.label, redactOpts).value;
  }
  return input;
}

function safeLaneField(value: string, ctx: GjcNormalizerContext): string {
  const redactOpts = { ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}), ...(ctx.projectDir ? { projectDir: ctx.projectDir } : {}), maxStringLength: 120 };
  return redactJsonValue(value, redactOpts).value;
}

function hasToolOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.length > 0 && content.every((b) => {
    const type = readString(asRecord(b), ["type"]);
    return type === "toolCall" || type === "tool_call" || type === "tool_use" || type === "toolResult" || type === "tool_result";
  });
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content.map((b) => (isRecord(b) ? readString(b, ["text", "content"]) : undefined)).filter((t): t is string => Boolean(t)).join("\n").trim();
    return text || undefined;
  }
  return undefined;
}

function measureText(record: UnknownRecord): number | undefined {
  const content = record.content ?? record.text ?? record.output;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    const total = content.reduce((sum, b) => sum + (isRecord(b) ? (readString(b, ["text", "content"])?.length ?? 0) : 0), 0);
    return total || undefined;
  }
  return undefined;
}

function shortLabel(text: string): string {
  const role = roleFromPrompt(text);
  if (role) return role;
  const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? text).trim();
  return firstLine.length > 36 ? `${firstLine.slice(0, 35)}…` : firstLine;
}

function gitKind(command: string): { kind: "git_push" | "git_commit"; label: string } | undefined {
  if (/\bgit\s+push\b/.test(command)) return { kind: "git_push", label: "Pushed changes" };
  if (/\bgit\s+commit\b/.test(command)) return { kind: "git_commit", label: "Recorded a commit" };
  return undefined;
}

function prettyTool(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep < 0 ? rest : `${rest.slice(0, sep)}: ${rest.slice(sep + 2)}`;
}

function readString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readPath(record: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function strlen(v: unknown): number | undefined {
  return typeof v === "string" ? v.length : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function asJsonObject(value: unknown): JsonObject {
  return (isRecord(value) ? sanitize(value) : {}) as JsonObject;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonObject {
  return sanitizeValue(value, seen) as JsonObject;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((v) => sanitizeValue(v, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol") continue;
    out[k] = sanitizeValue(v, seen);
  }
  seen.delete(value);
  return out;
}
