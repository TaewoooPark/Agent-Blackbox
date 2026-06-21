import {
  redactJsonObject,
  type JsonObject,
  type TraceEventInput
} from "@agent-blackbox/core";
import type { ClaudeNormalizerContext, ClaudeTranscriptLine, UnknownRecord } from "./types.js";

// --- Tool-name buckets ------------------------------------------------------
// Claude Code's public CLI uses Task/TodoWrite; this advanced harness uses
// Agent/TaskCreate/TaskUpdate. Map BOTH so the adapter works against either.
const READ_TOOLS = new Set(["read"]);
const EDIT_TOOLS = new Set(["edit", "multiedit", "applypatch", "apply_patch", "notebookedit"]);
const WRITE_TOOLS = new Set(["write"]);
const BASH_TOOLS = new Set(["bash", "shell"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "ls"]);
const SUBAGENT_TOOLS = new Set(["task", "agent"]);
const TODO_TOOLS = new Set(["todowrite", "taskcreate", "taskupdate", "taskstop"]);

/**
 * Stateful per-file normalizer. A Claude Code transcript pairs a tool call
 * (assistant `tool_use` block) with its result (a later `user` line carrying a
 * `tool_result` block + structured `toolUseResult`), so we hold a tool_use_id →
 * {name,input} map across lines, plus the last model for switch detection.
 */
export function createClaudeNormalizer(ctx: ClaudeNormalizerContext) {
  const toolUses = new Map<string, { name: string; input: JsonObject }>();
  let lastModel: string | undefined;

  const consume = (rawLine: ClaudeTranscriptLine): TraceEventInput[] => {
    const line = asRecord(rawLine);
    switch (readString(line, ["type"])) {
      case "assistant":
        return consumeAssistant(line, ctx, toolUses, (m) => (lastModel = m), () => lastModel);
      case "user":
        return consumeUser(line, ctx, toolUses);
      case "system":
        return consumeSystem(line, ctx);
      default:
        return [];
    }
  };

  return { consume };
}

// --- assistant line ---------------------------------------------------------
function consumeAssistant(
  line: UnknownRecord,
  ctx: ClaudeNormalizerContext,
  toolUses: Map<string, { name: string; input: JsonObject }>,
  setModel: (m: string) => void,
  getModel: () => string | undefined
): TraceEventInput[] {
  const events: TraceEventInput[] = [];
  const msg = asRecord(line.message);
  const model = readString(msg, ["model"]);

  // Real-token snapshot — the headline upgrade over char estimates. `input` is the
  // FULL prompt size that turn (uncached + cache read + cache write) so the
  // profiler's peak-context metric reflects true context pressure.
  const usage = asRecord(msg.usage);
  if (Object.keys(usage).length > 0) {
    const inputTokens = num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    events.push(
      mkInput(line, ctx, {
        kind: "message",
        summary: "assistant turn",
        payload: {
          role: "assistant",
          ...(model ? { model } : {}),
          tokens: {
            input: inputTokens,
            output: num(usage.output_tokens),
            cache: { read: num(usage.cache_read_input_tokens), write: num(usage.cache_creation_input_tokens) }
          }
        }
      })
    );
  }

  // Model switch (ignore the harness's `<synthetic>` placeholder model).
  if (model && model !== "<synthetic>" && model !== getModel()) {
    if (getModel()) events.push(mkInput(line, ctx, { kind: "model_switched", summary: `Model → ${model}`, payload: { model } }));
    setModel(model);
  }

  // Tool calls — register for result pairing, emit a tool_call node.
  for (const block of asArray(msg.content)) {
    const b = asRecord(block);
    if (readString(b, ["type"]) !== "tool_use") continue;
    const id = readString(b, ["id"]);
    const name = readString(b, ["name"]) ?? "unknown-tool";
    const input = asJsonObject(b.input);
    if (id) toolUses.set(id, { name, input });
    events.push(
      mkInput(line, ctx, {
        kind: "tool_call",
        summary: `tool.call:${name}`,
        payload: { tool: name, ...(id ? { callID: id } : {}) }
      })
    );
  }
  return events;
}

// --- user line --------------------------------------------------------------
function consumeUser(
  line: UnknownRecord,
  ctx: ClaudeNormalizerContext,
  toolUses: Map<string, { name: string; input: JsonObject }>
): TraceEventInput[] {
  const events: TraceEventInput[] = [];
  const msg = asRecord(line.message);

  // A genuine human prompt (typed/queued), not an injected/meta/tool-result line.
  const promptSource = readString(line, ["promptSource"]);
  const isMeta = line.isMeta === true;
  if (!isMeta && (promptSource === "typed" || promptSource === "queued")) {
    const text = extractText(msg.content);
    if (text) events.push(mkInput(line, ctx, { kind: "message", summary: "user prompt", payload: { role: "user", text } }));
  }

  const toolUseResult = line.toolUseResult;
  for (const block of asArray(msg.content)) {
    const b = asRecord(block);
    if (readString(b, ["type"]) !== "tool_result") continue;
    const id = readString(b, ["tool_use_id"]);
    const call = id ? toolUses.get(id) : undefined;
    if (!call) continue;
    const observed = deriveObserved(call.name, call.input, b, toolUseResult, line, ctx);
    if (observed) events.push(observed);
  }
  return events;
}

// --- system line ------------------------------------------------------------
function consumeSystem(line: UnknownRecord, ctx: ClaudeNormalizerContext): TraceEventInput[] {
  if (readString(line, ["subtype"]) === "compact_boundary") {
    return [mkInput(line, ctx, { kind: "context_compacted", summary: "Context compacted", payload: {} })];
  }
  return [];
}

// --- tool result → observed event ------------------------------------------
function deriveObserved(
  name: string,
  input: JsonObject,
  resultBlock: UnknownRecord,
  toolUseResult: unknown,
  line: UnknownRecord,
  ctx: ClaudeNormalizerContext
): TraceEventInput | undefined {
  const lname = name.toLowerCase();
  const tur = asRecord(toolUseResult);
  const isError = resultBlock.is_error === true;

  if (READ_TOOLS.has(lname)) {
    const path = readString(asRecord(tur.file), ["filePath"]) ?? readString(input, ["file_path", "path"]);
    const chars = strlen(readPath(tur, "file.content")) ?? measureResultText(resultBlock);
    return mkInput(line, ctx, {
      kind: "file_read",
      summary: path ? `Read ${path}` : "Read file",
      payload: { ...(path ? { path } : {}), ...(chars !== undefined ? { chars } : {}) }
    });
  }

  if (EDIT_TOOLS.has(lname)) {
    const path = readString(tur, ["filePath"]) ?? readString(input, ["file_path", "path"]);
    const chars = strlen(tur.newString) ?? strlen(input.new_string) ?? measureResultText(resultBlock);
    return mkInput(line, ctx, {
      kind: "file_edit",
      summary: path ? `Edited ${path}` : "Edited file",
      payload: { ...(path ? { path } : {}), ...(chars !== undefined ? { chars } : {}) }
    });
  }

  if (WRITE_TOOLS.has(lname)) {
    const path = readString(tur, ["filePath"]) ?? readString(input, ["file_path", "path"]);
    const chars = strlen(tur.content) ?? strlen(input.content) ?? measureResultText(resultBlock);
    return mkInput(line, ctx, {
      kind: "file_created",
      summary: path ? `Created ${path}` : "Created file",
      payload: { ...(path ? { path } : {}), ...(chars !== undefined ? { chars } : {}) }
    });
  }

  if (BASH_TOOLS.has(lname)) {
    const command = readString(input, ["command"]);
    const outputChars = (strlen(tur.stdout) ?? 0) + (strlen(tur.stderr) ?? 0) || measureResultText(resultBlock) || 0;
    return mkInput(line, ctx, {
      kind: "bash",
      summary: command ? `Ran ${command}` : "Ran shell command",
      payload: {
        ...(command ? { command } : {}),
        exitCode: isError ? 1 : 0,
        outputChars,
        ...(readString(input, ["description"]) ? { description: readString(input, ["description"]) } : {})
      }
    });
  }

  if (SEARCH_TOOLS.has(lname)) {
    const query = readString(input, ["pattern", "query", "glob", "path"]);
    return mkInput(line, ctx, {
      kind: "search",
      summary: query ? `Searched ${query}` : "Searched",
      payload: { ...(query ? { query } : {}) }
    });
  }

  if (SUBAGENT_TOOLS.has(lname)) {
    const label = readString(input, ["subagent_type", "description"]) ?? "subagent";
    const agentId = readString(tur, ["agentId"]) ?? label;
    const ev = mkInput(line, ctx, {
      kind: "subagent_spawned",
      summary: `Delegated to ${label}`,
      payload: {
        agent: label,
        agentId,
        ...(readString(input, ["description"]) ? { description: readString(input, ["description"]) } : {}),
        ...(shorten(readString(input, ["prompt"]), 600) ? { prompt: shorten(readString(input, ["prompt"]), 600) } : {})
      }
    });
    // Fork the lane: the spawn belongs to the subagent it launched.
    ev.agentId = agentId;
    ev.agentRole = "subagent";
    return ev;
  }

  if (TODO_TOOLS.has(lname)) {
    return mkInput(line, ctx, { kind: "todo_updated", summary: "Updated todos", payload: {} });
  }

  // Any other tool (Skill, WebFetch, MCP, …) is still a real action.
  const outputChars = measureResultText(resultBlock) ?? strlen(tur.result) ?? strlen(tur.text);
  return mkInput(line, ctx, {
    kind: "tool_result",
    summary: `Used ${name}`,
    payload: { tool: name, ...(outputChars !== undefined ? { outputChars } : {}) }
  });
}

// --- shared event builder ---------------------------------------------------
function mkInput(
  line: UnknownRecord,
  ctx: ClaudeNormalizerContext,
  partial: { kind: TraceEventInput["kind"]; summary: string; payload: Record<string, unknown> }
): TraceEventInput {
  const redacted = redactJsonObject(sanitize(partial.payload), {
    ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
    ...(ctx.projectDir ? { projectDir: ctx.projectDir } : {}),
    maxStringLength: 4000
  });
  // A Claude Code transcript line ALWAYS carries the parent session id: a main
  // session's own id, and — crucially — a subagent's agent-<id>.jsonl carries the
  // PARENT session's id too. So runId = sessionId nests subagents under their
  // parent run for free, no spawn registry needed.
  const sessionId = readString(line, ["sessionId"]) ?? ctx.defaultSessionId;
  const ts = readString(line, ["timestamp"]);
  const cwd = readString(line, ["cwd"]);
  const input: TraceEventInput = {
    host: "claude-code",
    runId: sessionId,
    sessionId,
    kind: partial.kind,
    summary: partial.summary,
    payload: redacted.value,
    redaction: { rawStored: ctx.rawStored ?? false, rulesApplied: redacted.rulesApplied, truncated: redacted.truncated }
  };
  if (ts) input.ts = ts;
  if (cwd) input.cwd = cwd;
  // Subagent transcript: fork a lane (agentId) under the shared parent session.
  if (ctx.agent) {
    input.agentId = ctx.agent.agentId;
    input.agentRole = "subagent";
  }
  return input;
}

// --- helpers ----------------------------------------------------------------
function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (isRecord(b) && readString(b, ["type"]) === "text" ? readString(b, ["text"]) : undefined))
      .filter((t): t is string => Boolean(t))
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

function measureResultText(resultBlock: UnknownRecord): number | undefined {
  const content = resultBlock.content;
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const b of content) {
      const t = isRecord(b) ? readString(b, ["text"]) : undefined;
      if (t) total += t.length;
    }
    return total || undefined;
  }
  return undefined;
}

function strlen(v: unknown): number | undefined {
  return typeof v === "string" ? v.length : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function shorten(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  return v.length <= max ? v : `${v.slice(0, max)}...`;
}

function readString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "string" && value.length > 0) return value;
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

/** Strip non-JSON values (undefined/function/symbol) and break cycles. */
function sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonObject {
  return sanitizeValue(value, seen) as JsonObject;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
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
