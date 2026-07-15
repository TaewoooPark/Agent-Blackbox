import {
  redactJsonObject,
  redactJsonValue,
  type JsonObject,
  type TraceEventInput
} from "@agent-blackbox/core";
import type { CodexNormalizerContext, CodexTranscriptLine, UnknownRecord } from "./types.js";

type ToolCall = { name: string; input: UnknownRecord; rawInput?: string };

type MutableContext = {
  runId: string;
  sessionId: string;
  threadId: string;
  cwd?: string;
  model?: string;
  turnId?: string;
  parentSessionId?: string;
  agentId?: string;
  agentLabel?: string;
};

/**
 * Stateful normalizer for Codex rollout JSONL. Structured event_msg records are
 * preferred; response_item tool calls are the fallback used by code-mode/app
 * sessions that do not persist command begin/end events.
 */
export function createCodexNormalizer(ctx: CodexNormalizerContext) {
  const state: MutableContext = {
    runId: ctx.defaultSessionId,
    sessionId: ctx.defaultSessionId,
    threadId: ctx.defaultSessionId,
    ...(ctx.projectDir ? { cwd: ctx.projectDir } : {})
  };
  const toolCalls = new Map<string, ToolCall>();
  const structuredPatchCalls = new Set<string>();
  const structuredExecCalls = new Set<string>();
  let emittedSessionMeta = false;
  let lastTokenSignature: string | undefined;

  const prime = (rawLine: CodexTranscriptLine): void => {
    const line = asRecord(rawLine);
    const type = readString(line, ["type"]);
    if (type === "session_meta") updateSessionMeta(asRecord(line.payload), state);
    if (type === "turn_context") updateTurnContext(asRecord(line.payload), state);
  };

  const consume = (rawLine: CodexTranscriptLine): TraceEventInput[] => {
    const line = asRecord(rawLine);
    const type = readString(line, ["type"]);
    const payload = asRecord(line.payload);

    if (type === "session_meta") {
      updateSessionMeta(payload, state);
      if (emittedSessionMeta) return [];
      emittedSessionMeta = true;
      const subagent = Boolean(state.agentId);
      return [
        mkInput(line, ctx, state, {
          kind: subagent ? "agent_start" : "session_created",
          summary: subagent ? `Subagent started: ${state.agentLabel ?? state.agentId}` : "Codex session started",
          payload: {
            source: describeSource(payload.source),
            ...(readString(payload, ["cli_version"]) ? { cliVersion: readString(payload, ["cli_version"]) } : {}),
            ...(readString(payload, ["model_provider"]) ? { modelProvider: readString(payload, ["model_provider"]) } : {})
          }
        })
      ];
    }

    if (type === "turn_context") {
      const previousModel = state.model;
      updateTurnContext(payload, state);
      if (previousModel && state.model && previousModel !== state.model) {
        return [mkInput(line, ctx, state, { kind: "model_switched", summary: `Model → ${state.model}`, payload: { model: state.model } })];
      }
      return [];
    }

    if (type === "compacted") {
      return [mkInput(line, ctx, state, { kind: "context_compacted", summary: "Context compacted", payload: {} })];
    }

    if (type === "event_msg") {
      const eventType = readString(payload, ["type"]);
      switch (eventType) {
        case "task_started":
        case "turn_started": {
          const turnId = readString(payload, ["turn_id"]);
          if (turnId) state.turnId = turnId;
          return [mkInput(line, ctx, state, { kind: "turn_start", summary: "Turn started", payload: {} })];
        }
        case "task_complete":
        case "turn_complete":
          return [
            mkInput(line, ctx, state, {
              kind: "turn_end",
              summary: payload.error ? "Turn failed" : "Turn completed",
              payload: {
                ...(readNumber(payload, ["duration_ms"]) !== undefined ? { durationMs: readNumber(payload, ["duration_ms"]) } : {}),
                ...(payload.error ? { error: true } : {})
              }
            })
          ];
        case "user_message": {
          const text = readString(payload, ["message"]);
          return text
            ? [mkInput(line, ctx, state, { kind: "message", summary: "user prompt", payload: { role: "user", text } })]
            : [];
        }
        case "token_count": {
          const usage = asRecord(asRecord(payload.info).last_token_usage);
          if (Object.keys(usage).length === 0) return [];
          const signature = JSON.stringify(usage);
          if (signature === lastTokenSignature) return [];
          lastTokenSignature = signature;
          const input = num(usage.input_tokens);
          const output = num(usage.output_tokens);
          const cacheRead = num(usage.cached_input_tokens);
          return [
            mkInput(line, ctx, state, {
              kind: "message",
              summary: "assistant turn",
              payload: {
                role: "assistant",
                ...(state.model ? { model: state.model } : {}),
                tokens: { input, output, cache: { read: cacheRead, write: 0 } }
              }
            })
          ];
        }
        case "patch_apply_end":
          return consumePatchEnd(line, payload, ctx, state, structuredPatchCalls, toolCalls);
        case "exec_command_begin":
          return consumeExecBegin(line, payload, ctx, state, toolCalls, structuredExecCalls);
        case "exec_command_end":
          return consumeExecEnd(line, payload, ctx, state, toolCalls, structuredExecCalls);
        case "web_search_end": {
          const query = readString(payload, ["query"]);
          return [mkInput(line, ctx, state, { kind: "search", summary: query ? `Searched ${query}` : "Web search", payload: { ...(query ? { query } : {}) } })];
        }
        case "mcp_tool_call_end":
          return consumeMcpEnd(line, payload, ctx, state);
        case "dynamic_tool_call_response": {
          const tool = readString(payload, ["tool"]) ?? "dynamic-tool";
          const success = payload.success !== false;
          return [mkInput(line, ctx, state, { kind: "tool_result", summary: success ? `Used ${prettyTool(tool)}` : `${prettyTool(tool)} failed`, payload: { tool, success, outputChars: measureOutput(payload.content_items) } })];
        }
        case "view_image_tool_call": {
          const path = readString(payload, ["path"]);
          return [mkInput(line, ctx, state, { kind: "file_read", summary: path ? `Read ${path}` : "Read image", payload: { ...(path ? { path } : {}), image: true, chars: 6000 } })];
        }
        case "image_generation_end":
          return [mkInput(line, ctx, state, { kind: "tool_result", summary: "Generated image", payload: { tool: "image_generation", success: readString(payload, ["status"]) !== "failed" } })];
        case "context_compacted":
          return [mkInput(line, ctx, state, { kind: "context_compacted", summary: "Context compacted", payload: {} })];
        case "plan_update":
          return [mkInput(line, ctx, state, { kind: "todo_updated", summary: "Updated plan", payload: {} })];
        case "exec_approval_request":
        case "apply_patch_approval_request":
        case "request_permissions":
          return [mkInput(line, ctx, state, { kind: "permission_asked", summary: "Permission requested", payload: { event: eventType } })];
        case "sub_agent_activity":
          return consumeSubagentActivity(line, payload, ctx, state);
        case "error":
          return [mkInput(line, ctx, state, { kind: "session_error", summary: "Codex error", payload: { message: readString(payload, ["message"]) ?? "unknown error" } })];
        case "stream_error":
          return [mkInput(line, ctx, state, { kind: "host_event", summary: "Stream error (retrying)", payload: { event: "stream_error" } })];
        case "turn_aborted":
          return [mkInput(line, ctx, state, { kind: "turn_end", summary: "Turn aborted", payload: { reason: readString(payload, ["reason"]) ?? "unknown" } })];
        case "model_reroute": {
          const model = readString(payload, ["model", "to_model", "rerouted_model"]);
          if (!model) return [];
          state.model = model;
          return [mkInput(line, ctx, state, { kind: "model_switched", summary: `Model → ${model}`, payload: { model } })];
        }
        default:
          return [];
      }
    }

    if (type === "response_item") {
      return consumeResponseItem(line, payload, ctx, state, toolCalls, structuredPatchCalls, structuredExecCalls);
    }

    return [];
  };

  return { consume, prime };
}

function consumeResponseItem(
  line: UnknownRecord,
  payload: UnknownRecord,
  ctx: CodexNormalizerContext,
  state: MutableContext,
  toolCalls: Map<string, ToolCall>,
  structuredPatchCalls: Set<string>,
  structuredExecCalls: Set<string>
): TraceEventInput[] {
  const type = readString(payload, ["type"]);
  if (type === "function_call" || type === "custom_tool_call") {
    const callId = readString(payload, ["call_id"]);
    const call = parseToolCall(payload);
    if (callId) toolCalls.set(callId, call);
    if (callId && structuredExecCalls.has(callId)) return [];
    return [
      mkInput(line, ctx, state, {
        kind: "tool_call",
        summary: `tool.call:${prettyTool(call.name)}`,
        payload: { tool: call.name, ...(callId ? { callID: callId } : {}) }
      })
    ];
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = readString(payload, ["call_id"]);
    if (callId && structuredExecCalls.has(callId)) {
      toolCalls.delete(callId);
      return [];
    }
    const call = callId ? toolCalls.get(callId) : undefined;
    if (!call) return [];
    toolCalls.delete(callId!);
    if (call.name === "apply_patch" && callId && structuredPatchCalls.has(callId)) return [];
    return deriveToolResult(line, call, payload.output, ctx, state);
  }

  if (type === "web_search_call") {
    const action = asRecord(payload.action);
    const query = readString(action, ["query"]);
    return [mkInput(line, ctx, state, { kind: "search", summary: query ? `Searched ${query}` : "Web search", payload: { ...(query ? { query } : {}) } })];
  }

  if (type === "context_compaction" || type === "compaction" || type === "compaction_summary") {
    return [mkInput(line, ctx, state, { kind: "context_compacted", summary: "Context compacted", payload: {} })];
  }

  return [];
}

function consumeExecBegin(
  line: UnknownRecord,
  payload: UnknownRecord,
  ctx: CodexNormalizerContext,
  state: MutableContext,
  toolCalls: Map<string, ToolCall>,
  structuredExecCalls: Set<string>
): TraceEventInput[] {
  const callId = readString(payload, ["call_id"]);
  const command = commandFromPayload(payload);
  const cwd = readString(payload, ["cwd"]);
  const turnId = readString(payload, ["turn_id"]);
  if (cwd) state.cwd = cwd;
  if (turnId) state.turnId = turnId;
  const call: ToolCall = { name: "bash", input: { ...(command ? { command } : {}), ...(cwd ? { workdir: cwd } : {}) } };

  // Some Codex surfaces persist both an outer response_item call and an inner
  // structured exec event with different IDs. Reuse the already-emitted outer
  // tool_call and let the structured end event provide the one semantic result.
  const pending = [...toolCalls.entries()].reverse().find(([id, candidate]) => candidate.name === "bash" && !structuredExecCalls.has(id));
  if (pending) {
    structuredExecCalls.add(pending[0]);
    if (callId) {
      structuredExecCalls.add(callId);
      toolCalls.set(callId, call);
    }
    return [];
  }

  if (callId) {
    structuredExecCalls.add(callId);
    toolCalls.set(callId, call);
  }
  return [mkInput(line, ctx, state, { kind: "tool_call", summary: "tool.call:bash", payload: { tool: "bash", ...(callId ? { callID: callId } : {}) } })];
}

function consumeExecEnd(
  line: UnknownRecord,
  payload: UnknownRecord,
  ctx: CodexNormalizerContext,
  state: MutableContext,
  toolCalls: Map<string, ToolCall>,
  structuredExecCalls: Set<string>
): TraceEventInput[] {
  const callId = readString(payload, ["call_id"]);
  if (callId) structuredExecCalls.add(callId);
  const stored = callId ? toolCalls.get(callId) : undefined;
  if (callId) toolCalls.delete(callId);
  const command = readString(stored?.input ?? {}, ["command"]) ?? commandFromPayload(payload);
  const exitCode = readNumber(payload, ["exit_code"]);
  const failed = (exitCode !== undefined && exitCode !== 0) || readString(payload, ["status"]) === "failed";
  const outputChars = readString(payload, ["aggregated_output", "formatted_output"])?.length ??
    (readString(payload, ["stdout"])?.length ?? 0) + (readString(payload, ["stderr"])?.length ?? 0);
  if (command) return classifyShell(command, outputChars, failed, line, ctx, state);
  return [mkInput(line, ctx, state, { kind: "tool_result", summary: failed ? "Bash failed" : "Used bash", payload: { tool: "bash", success: !failed, outputChars } })];
}

function parseToolCall(payload: UnknownRecord): ToolCall {
  const name = readString(payload, ["name"]) ?? "unknown-tool";
  if (readString(payload, ["type"]) === "function_call") {
    const raw = readString(payload, ["arguments"]) ?? "";
    return { name: normalizeToolName(name), input: parseObject(raw), rawInput: raw };
  }
  const raw = readString(payload, ["input"]) ?? "";
  if (name === "exec") {
    const patch = extractJsString(raw, /(?:const|let)\s+patch\s*=\s*("(?:\\.|[^"\\])*")/s);
    if (raw.includes("tools.apply_patch") || raw.includes("apply_patch(")) {
      return { name: "apply_patch", input: patch ? { patch } : {}, rawInput: raw };
    }
    const command = extractJsString(raw, /(?:\bcmd|"cmd")\s*:\s*("(?:\\.|[^"\\])*")/s);
    const workdir = extractJsString(raw, /(?:\bworkdir|"workdir")\s*:\s*("(?:\\.|[^"\\])*")/s);
    if (command) return { name: "bash", input: { command, ...(workdir ? { workdir } : {}) }, rawInput: raw };
  }
  return { name: normalizeToolName(name), input: {}, rawInput: raw };
}

function deriveToolResult(
  line: UnknownRecord,
  call: ToolCall,
  output: unknown,
  ctx: CodexNormalizerContext,
  state: MutableContext
): TraceEventInput[] {
  const outputChars = measureOutput(output);
  const failed = outputFailed(output);
  if (call.name === "bash") {
    const command = readString(call.input, ["command"]);
    if (command) return classifyShell(command, outputChars, failed, line, ctx, state);
  }
  if (call.name === "apply_patch") {
    const patch = readString(call.input, ["patch"]);
    if (patch) {
      const changes = parsePatchChanges(patch);
      if (changes.length > 0 && !failed) {
        return changes.map((change) =>
          mkInput(line, ctx, state, {
            kind: change.kind,
            summary: `${change.label} ${change.path}`,
            payload: { path: change.path, chars: change.chars }
          })
        );
      }
    }
  }
  return [
    mkInput(line, ctx, state, {
      kind: "tool_result",
      summary: failed ? `${prettyTool(call.name)} failed` : `Used ${prettyTool(call.name)}`,
      payload: { tool: call.name, outputChars, success: !failed }
    })
  ];
}

function consumePatchEnd(
  line: UnknownRecord,
  payload: UnknownRecord,
  ctx: CodexNormalizerContext,
  state: MutableContext,
  structuredPatchCalls: Set<string>,
  toolCalls: Map<string, ToolCall>
): TraceEventInput[] {
  const callId = readString(payload, ["call_id"]);
  if (callId) structuredPatchCalls.add(callId);
  // Codex code mode currently gives the outer custom tool call and the inner
  // patch event different IDs. Mark any in-flight patch fallback as covered by
  // this richer structured event so the edit appears exactly once.
  for (const [pendingId, call] of toolCalls) {
    if (call.name === "apply_patch") structuredPatchCalls.add(pendingId);
  }
  if (payload.success === false) {
    return [mkInput(line, ctx, state, { kind: "tool_result", summary: "Patch failed", payload: { tool: "apply_patch", success: false, outputChars: strlen(payload.stderr) ?? 0 } })];
  }
  const changes = asRecord(payload.changes);
  const events: TraceEventInput[] = [];
  for (const [path, value] of Object.entries(changes)) {
    const change = asRecord(value);
    const type = readString(change, ["type"]);
    const kind: TraceEventInput["kind"] = type === "add" ? "file_created" : type === "delete" ? "file_deleted" : "file_edit";
    const verb = type === "add" ? "Created" : type === "delete" ? "Deleted" : "Edited";
    const chars = strlen(change.content) ?? strlen(change.unified_diff) ?? 0;
    events.push(mkInput(line, ctx, state, { kind, summary: `${verb} ${path}`, payload: { path, chars, ...(readString(change, ["move_path"]) ? { movePath: readString(change, ["move_path"]) } : {}) } }));
  }
  return events.length > 0 ? events : [mkInput(line, ctx, state, { kind: "tool_result", summary: "Applied patch", payload: { tool: "apply_patch", success: true } })];
}

function consumeMcpEnd(line: UnknownRecord, payload: UnknownRecord, ctx: CodexNormalizerContext, state: MutableContext): TraceEventInput[] {
  const invocation = asRecord(payload.invocation);
  const server = readString(invocation, ["server"]);
  const tool = readString(invocation, ["tool"]) ?? "mcp-tool";
  const label = server ? `${server}: ${tool}` : tool;
  const result = asRecord(payload.result);
  const ok = asRecord(result.Ok);
  const success = !("Err" in result) && ok.is_error !== true && ok.isError !== true;
  const toolName = server ? `mcp__${server}__${tool}` : tool;
  const callId = readString(payload, ["call_id"]);
  return [
    mkInput(line, ctx, state, { kind: "tool_call", summary: `tool.call:${label}`, payload: { tool: toolName, ...(callId ? { callID: callId } : {}) } }),
    mkInput(line, ctx, state, {
      kind: "tool_result",
      summary: success ? `Used ${label}` : `${label} failed`,
      payload: { tool: toolName, success, outputChars: measureOutput(payload.result) }
    })
  ];
}

function consumeSubagentActivity(line: UnknownRecord, payload: UnknownRecord, ctx: CodexNormalizerContext, state: MutableContext): TraceEventInput[] {
  if (readString(payload, ["kind"]) !== "started") return [];
  const agentId = readString(payload, ["agent_thread_id"]);
  if (!agentId) return [];
  const path = readString(payload, ["agent_path"]);
  const label = path ? path.split("/").filter(Boolean).at(-1) : undefined;
  const event = mkInput(line, ctx, state, {
    kind: "subagent_spawned",
    summary: `Delegated to ${label ?? "subagent"}`,
    payload: { agent: label ?? "subagent", agentId, ...(path ? { agentPath: path } : {}) }
  });
  event.agentId = agentId;
  event.agentRole = "subagent";
  if (label) event.agentLabel = label;
  return [event];
}

function classifyShell(
  command: string,
  outputChars: number,
  failed: boolean,
  line: UnknownRecord,
  ctx: CodexNormalizerContext,
  state: MutableContext
): TraceEventInput[] {
  const segments = splitShellSegments(command);
  const perSegment = Math.max(0, Math.round(outputChars / Math.max(segments.length, 1)));
  const events: TraceEventInput[] = [];
  for (const segment of segments) {
    const words = shellWords(segment);
    const verb = basename(words[0] ?? "");
    const git = gitCommand(segment);
    if (git) {
      events.push(mkInput(line, ctx, state, { kind: git.kind, summary: failed ? `${git.label} (failed)` : git.label, payload: { command: segment, exitCode: failed ? 1 : 0, outputChars: perSegment } }));
      continue;
    }
    if (["cat", "head", "tail", "sed", "wc"].includes(verb)) {
      const path = lastFileArgument(words, verb);
      events.push(mkInput(line, ctx, state, { kind: "file_read", summary: path ? `Read ${path}` : `Ran ${verb}`, payload: { ...(path ? { path } : {}), chars: perSegment } }));
      continue;
    }
    if (["rg", "grep", "find", "fd", "ls"].includes(verb)) {
      const query = firstQueryArgument(words);
      events.push(mkInput(line, ctx, state, { kind: "search", summary: query ? `Searched ${query}` : "Searched", payload: { ...(query ? { query } : {}), outputChars: perSegment } }));
      continue;
    }
    events.push(mkInput(line, ctx, state, { kind: "bash", summary: `Ran ${segment}`, payload: { command: segment, exitCode: failed ? 1 : 0, outputChars: perSegment } }));
  }
  return events;
}

function updateSessionMeta(payload: UnknownRecord, state: MutableContext): void {
  const threadId = readString(payload, ["id"]) ?? state.threadId;
  const parent = readString(payload, ["parent_thread_id", "forked_from_id"]);
  const root = readString(payload, ["session_id"]) ?? parent ?? threadId;
  state.runId = root;
  state.sessionId = root;
  state.threadId = threadId;
  const cwd = readString(payload, ["cwd"]);
  if (cwd) state.cwd = cwd;
  const source = isRecord(payload.source) ? payload.source : undefined;
  const subagent =
    readString(payload, ["thread_source"]) === "subagent" ||
    Boolean(parent) ||
    Boolean(source && Object.prototype.hasOwnProperty.call(source, "subagent"));
  if (subagent) {
    state.parentSessionId = parent ?? root;
    state.agentId = readString(payload, ["agent_path", "id"]) ?? threadId;
    const agentPath = readString(payload, ["agent_path"]);
    const agentLabel =
      readString(payload, ["agent_role", "agent_nickname"]) ??
      (agentPath ? agentPath.split("/").filter(Boolean).at(-1) : undefined);
    if (agentLabel) state.agentLabel = agentLabel;
  }
}

function updateTurnContext(payload: UnknownRecord, state: MutableContext): void {
  const cwd = readString(payload, ["cwd"]);
  const model = readString(payload, ["model"]);
  const turnId = readString(payload, ["turn_id"]);
  if (cwd) state.cwd = cwd;
  if (model) state.model = model;
  if (turnId) state.turnId = turnId;
}

function mkInput(
  line: UnknownRecord,
  ctx: CodexNormalizerContext,
  state: MutableContext,
  partial: { kind: TraceEventInput["kind"]; summary: string; payload: Record<string, unknown> }
): TraceEventInput {
  const redactOpts = {
    ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
    ...(state.cwd ? { projectDir: state.cwd } : ctx.projectDir ? { projectDir: ctx.projectDir } : {}),
    maxStringLength: 4000
  };
  const redacted = redactJsonObject(sanitize(partial.payload), redactOpts);
  const event: TraceEventInput = {
    host: "codex",
    runId: state.runId,
    sessionId: state.sessionId,
    kind: partial.kind,
    summary: redactJsonValue(partial.summary, redactOpts).value,
    payload: redacted.value,
    redaction: { rawStored: ctx.rawStored ?? false, rulesApplied: redacted.rulesApplied, truncated: redacted.truncated }
  };
  const ts = readString(line, ["timestamp"]);
  if (ts) event.ts = ts;
  if (state.cwd) event.cwd = redactJsonValue(state.cwd, redactOpts).value;
  if (state.turnId) event.turnId = state.turnId;
  if (state.parentSessionId) event.parentSessionId = state.parentSessionId;
  if (state.agentId) {
    event.agentId = state.agentId;
    event.agentRole = "subagent";
    if (state.agentLabel) event.agentLabel = redactJsonValue(state.agentLabel, redactOpts).value;
  }
  return event;
}

type ParsedPatchChange = { kind: "file_created" | "file_edit" | "file_deleted"; label: string; path: string; chars: number };

function parsePatchChanges(patch: string): ParsedPatchChange[] {
  const out: ParsedPatchChange[] = [];
  const pattern = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (const match of patch.matchAll(pattern)) {
    const action = match[1];
    const path = match[2]?.trim();
    if (!action || !path) continue;
    out.push({
      kind: action === "Add" ? "file_created" : action === "Delete" ? "file_deleted" : "file_edit",
      label: action === "Add" ? "Created" : action === "Delete" ? "Deleted" : "Edited",
      path,
      chars: patch.length
    });
  }
  return out;
}

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  if (["shell", "shell_command", "exec_command", "unified_exec"].includes(lower)) return "bash";
  return lower;
}

function extractJsString(source: string, pattern: RegExp): string | undefined {
  const literal = source.match(pattern)?.[1];
  if (!literal) return undefined;
  try {
    return JSON.parse(literal) as string;
  } catch {
    return undefined;
  }
}

function parseObject(raw: string): UnknownRecord {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function commandFromPayload(payload: UnknownRecord): string | undefined {
  if (typeof payload.command === "string") return payload.command;
  if (!Array.isArray(payload.command)) return undefined;
  const argv = payload.command.filter((value): value is string => typeof value === "string");
  if (argv.length === 0) return undefined;
  const shellFlag = argv.findIndex((value) => value === "-c" || value === "-lc");
  return shellFlag >= 0 && argv[shellFlag + 1] ? argv[shellFlag + 1] : argv.join(" ");
}

function splitShellSegments(command: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||") {
      const part = command.slice(start, i).trim();
      if (part) out.push(part);
      i += 1;
      start = i + 1;
    } else if (ch === ";") {
      const part = command.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) out.push(tail);
  return out.length > 0 ? out : [command];
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words;
}

function lastFileArgument(words: string[], verb: string): string | undefined {
  const candidates = words.slice(1).filter((word) => word !== "--" && !word.startsWith("-") && !(verb === "sed" && /^\d+(?:,\d+)?p$/.test(word)));
  return candidates.at(-1);
}

function firstQueryArgument(words: string[]): string | undefined {
  return words.slice(1).find((word) => word !== "--" && !word.startsWith("-"));
}

function gitCommand(command: string): { kind: "git_status" | "git_commit" | "git_push"; label: string } | undefined {
  if (/\bgit\s+push\b/.test(command)) return { kind: "git_push", label: "Pushed changes" };
  if (/\bgit\s+commit\b/.test(command)) return { kind: "git_commit", label: "Recorded a commit" };
  if (/\bgit\s+status\b/.test(command)) return { kind: "git_status", label: "Checked git status" };
  return undefined;
}

function outputFailed(output: unknown): boolean {
  const text = outputText(output);
  return /Script failed|exit(?:_| )code[^0-9-]*[1-9]|Process exited with code [1-9]/i.test(text);
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.map((item) => readString(asRecord(item), ["text", "content"]) ?? "").join("\n");
}

function measureOutput(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) return output.reduce((sum, item) => sum + (readString(asRecord(item), ["text", "content"])?.length ?? 0), 0);
  try {
    return JSON.stringify(output).length;
  } catch {
    return 0;
  }
}

function describeSource(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return Object.keys(value)[0] ?? "unknown";
  return "unknown";
}

function prettyTool(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep < 0 ? rest : `${rest.slice(0, sep)}: ${rest.slice(sep + 2)}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function readString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strlen(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
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
    const out = value.map((item) => sanitizeValue(item, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") continue;
    out[key] = sanitizeValue(item, seen);
  }
  seen.delete(value);
  return out;
}
