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
const SEARCH_TOOLS = new Set(["grep", "glob", "ls", "websearch"]);
const SUBAGENT_TOOLS = new Set(["task", "agent"]);
const TODO_TOOLS = new Set(["todowrite", "taskcreate", "taskupdate", "taskstop"]);
// A Workflow / ultracode run fans out to a fleet of agents — model it as a spawn.
const WORKFLOW_TOOLS = new Set(["workflow"]);
// Skill = a slash-command invocation.
const COMMAND_TOOLS = new Set(["skill"]);
// Agent-team coordination (FleetView). Rare; surfaced as host events for visibility.
const TEAM_TOOLS = new Set(["sendmessage", "teamcreate", "teamdelete", "remotetrigger", "pushnotification"]);

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
  // For a subagent transcript, the first user line is the task it was given — use a
  // short form as the lane's readable label (far better than the opaque agent id).
  if (ctx.agent && !ctx.agent.label) {
    const task = extractText(msg.content);
    if (task) ctx.agent.label = shortLabel(task);
  }

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
  const subtype = readString(line, ["subtype"]);
  if (subtype === "compact_boundary") {
    return [mkInput(line, ctx, { kind: "context_compacted", summary: "Context compacted", payload: {} })];
  }
  if (subtype === "api_error") {
    return [mkInput(line, ctx, { kind: "host_event", summary: "API error", payload: { event: "api_error", ...(readString(line, ["level"]) ? { level: readString(line, ["level"]) } : {}) } })];
  }
  if (subtype === "local_command") {
    return [mkInput(line, ctx, { kind: "command_run", summary: "Local command", payload: { event: "local_command" } })];
  }
  if (subtype === "stop_hook_summary") {
    // Hooks fire constantly; only surface the ones that actually intervened — a hook
    // that blocked continuation or errored is operationally meaningful, the rest noise.
    const prevented = line.preventedContinuation === true;
    const errors = asArray(line.hookErrors);
    if (prevented || errors.length > 0) {
      return [
        mkInput(line, ctx, {
          kind: "host_event",
          summary: prevented ? "Hook blocked continuation" : "Hook error",
          payload: { event: "hook", preventedContinuation: prevented, hookErrors: errors.length }
        })
      ];
    }
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
    const fileRec = asRecord(tur.file);
    const path = readString(fileRec, ["filePath"]) ?? readString(input, ["file_path", "path"]);
    // An image Read carries base64, not text — give it an estimated char cost so it
    // still registers in the redundant-read metric and token attribution.
    const image = imageReadChars(tur, fileRec, resultBlock);
    const chars = strlen(fileRec.content) ?? measureResultText(resultBlock) ?? image;
    return mkInput(line, ctx, {
      kind: "file_read",
      summary: path ? `Read ${path}` : "Read file",
      payload: {
        ...(path ? { path } : {}),
        ...(chars !== undefined ? { chars } : {}),
        ...(image !== undefined ? { image: true } : {})
      }
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
    ev.agentLabel = label;
    return ev;
  }

  if (WORKFLOW_TOOLS.has(lname)) {
    // A Workflow (incl. ultracode) orchestrates a fleet of agents elsewhere — record
    // it as a delegation lane labelled by the workflow, keyed by its run id.
    const wfName = readString(tur, ["workflowName"]) ?? "workflow";
    const wfRun = readString(tur, ["runId"]);
    const ev = mkInput(line, ctx, {
      kind: "subagent_spawned",
      summary: `Ran workflow ${wfName}`,
      payload: {
        agent: `workflow:${wfName}`,
        ...(wfRun ? { agentId: wfRun } : {}),
        ...(readString(tur, ["summary"]) ? { description: readString(tur, ["summary"]) } : {})
      }
    });
    ev.agentId = wfRun ?? `workflow:${wfName}`;
    ev.agentRole = "subagent";
    ev.agentLabel = `workflow:${wfName}`;
    return ev;
  }

  if (COMMAND_TOOLS.has(lname)) {
    const cmd = readString(input, ["skill", "command"]) ?? readString(tur, ["commandName"]) ?? "command";
    return mkInput(line, ctx, { kind: "command_run", summary: `/${cmd}`, payload: { command: cmd } });
  }

  if (TEAM_TOOLS.has(lname)) {
    return mkInput(line, ctx, { kind: "host_event", summary: `Team: ${name}`, payload: { tool: name, event: "team" } });
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
  // Subagent transcript: fork a lane (agentId) under the shared parent session,
  // labelled by the subagent's task when known (set from its first prompt).
  if (ctx.agent) {
    input.agentId = ctx.agent.agentId;
    input.agentRole = "subagent";
    if (ctx.agent.label) input.agentLabel = ctx.agent.label;
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

// Estimate the context cost of an image Read as `chars` (the engine reads chars/4
// as tokens). Claude bills an image at ~(width*height)/750 tokens, so chars =
// tokens*4. Falls back to ~1500 tokens when dimensions are absent. Returns
// undefined for non-image reads.
function imageReadChars(tur: UnknownRecord, fileRec: UnknownRecord, resultBlock: UnknownRecord): number | undefined {
  // The image can live in the structured result (tur.type/file.base64) OR only in
  // the tool_result block content (older shape: toolUseResult is null, the block
  // carries [{type:"image"}]). Detect both.
  const isImage =
    readString(tur, ["type"]) === "image" || typeof fileRec.base64 === "string" || blockHasImage(resultBlock);
  if (!isImage) return undefined;
  const dims = asRecord(fileRec.dimensions);
  const w = readNumber(dims, ["width"]);
  const h = readNumber(dims, ["height"]);
  if (w !== undefined && h !== undefined && w > 0 && h > 0) return Math.round((w * h) / 750) * 4;
  return 6000;
}

function blockHasImage(resultBlock: UnknownRecord): boolean {
  const content = resultBlock.content;
  return Array.isArray(content) && content.some((b) => isRecord(b) && readString(b, ["type"]) === "image");
}

function readNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readPath(record, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function shorten(v: string | undefined, max: number): string | undefined {
  if (v === undefined) return undefined;
  return v.length <= max ? v : `${v.slice(0, max)}...`;
}

// A compact one-line lane label from a subagent's task prompt.
function shortLabel(text: string): string {
  const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? text).trim();
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
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
