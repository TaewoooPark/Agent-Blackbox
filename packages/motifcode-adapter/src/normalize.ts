import { redactJsonObject, redactJsonValue, type JsonObject, type TraceEventInput } from "@agent-blackbox/core";
import type { MotifcodeJournalLine, MotifcodeNormalizerContext, UnknownRecord } from "./types.js";

type Scope = { id: string; child: boolean; label?: string; parent?: string; turn?: string; content: boolean; ended: boolean };
type Call = { name: string; input: UnknownRecord };
type PartialEvent = { kind: TraceEventInput["kind"]; summary: string; payload: UnknownRecord };
const MAX_SCOPES = 256;
const MAX_PENDING_CALLS = 128;

/**
 * Motifcode @motifcode/journal v2, verified against Motifcode 0.4.1.
 * Each task has one journal; child scopes share that file. Checkpoints repeat
 * the entire conversation and must never be replayed as fresh messages/usage.
 * Contract: https://github.com/TaewoooPark/Motifcode/blob/9c34b45f5cd8e617f74be0a2c35aeaabb65c175b/packages/journal/src/index.ts
 * Events: https://github.com/TaewoooPark/Motifcode/blob/9c34b45f5cd8e617f74be0a2c35aeaabb65c175b/packages/core/src/events.ts
 */
export function createMotifcodeNormalizer(ctx: MotifcodeNormalizerContext) {
  let runId = ctx.defaultSessionId;
  let cwd = ctx.projectDir;
  let model: string | undefined;
  let lastSeq = 0;
  let created = false;
  const scopes = new Map<string, Scope>();
  const calls = new Map<string, Call>();

  function scopeFor(line: UnknownRecord): Scope {
    const id = str(line.scopeId)!;
    let scope = scopes.get(id);
    if (!scope) {
      scope = { id, child: line.scopeKind === "subagent", content: false, ended: false };
      scopes.set(id, scope);
      bound(scopes, MAX_SCOPES);
    }
    const label = str(line.agentName);
    const parent = str(line.parentScopeId);
    if (label) scope.label = label;
    if (parent) scope.parent = parent;
    return scope;
  }

  function make(line: UnknownRecord, scope: Scope | undefined, partial: PartialEvent): TraceEventInput {
    const options = { ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}), ...(cwd ? { projectDir: cwd } : {}), maxStringLength: 4000 };
    const payload = redactJsonObject(json(partial.payload), options);
    const summary = redactJsonValue(partial.summary, options);
    const label = scope?.label ? redactJsonValue(scope.label, options) : undefined;
    const timestamp = str(line.at) ?? str(record(line.header).startedAt);
    const results = [payload, summary, ...(label ? [label] : [])];
    return {
      host: "motifcode", runId, sessionId: runId,
      ...(timestamp && Number.isFinite(Date.parse(timestamp)) ? { ts: timestamp } : {}),
      // The actuator needs an absolute project path; redact displayed paths in
      // summaries/payloads, not this machine-local routing field.
      ...(cwd ? { cwd } : {}),
      ...(scope?.turn ? { turnId: scope.turn } : {}),
      ...(scope?.child ? { agentId: scope.id, agentRole: "subagent" as const, ...(label ? { agentLabel: label.value } : {}) } : {}),
      kind: partial.kind, summary: summary.value, payload: payload.value,
      redaction: {
        rawStored: ctx.rawStored ?? false,
        rulesApplied: [...new Set(results.flatMap((result) => result.rulesApplied))],
        truncated: results.some((result) => result.truncated)
      }
    };
  }

  function finish(line: UnknownRecord, scope: Scope, result: UnknownRecord): TraceEventInput[] {
    if (scope.ended) return [];
    scope.ended = true;
    const reason = str(result.reason) ?? str(result.endReason) ?? "unknown";
    const summary = str(result.summary);
    const out: TraceEventInput[] = [];
    if (summary && !scope.content) out.push(make(line, scope, { kind: "message", summary: "assistant response", payload: { role: "assistant", chars: summary.length, ...(model ? { model } : {}) } }));
    if (scope.turn) out.push(make(line, scope, { kind: "turn_end", summary: "Turn ended", payload: { reason, success: reason === "done" } }));
    delete scope.turn;
    out.push(make(line, scope, {
      kind: scope.child ? "agent_end" : reason === "done" ? "session_idle" : "session_error",
      summary: scope.child ? `Subagent ended: ${scope.label ?? scope.id}` : `Motifcode task ended: ${reason}`,
      payload: { reason, success: reason === "done", ...(scope.child ? { agentId: scope.id } : {}) }
    }));
    for (const key of calls.keys()) if (key.startsWith(`${scope.id}\0`)) calls.delete(key);
    return out;
  }

  function consume(raw: MotifcodeJournalLine): TraceEventInput[] {
    const line = record(raw);
    if (line.t === "header") {
      const header = record(line.header);
      const nextRun = str(header.runId);
      if (header.schemaVersion !== 2 || !nextRun) return [];
      if (nextRun !== runId) {
        runId = nextRun; lastSeq = 0; created = false; scopes.clear(); calls.clear();
      }
      cwd = str(record(header.repository).cwd) ?? ctx.projectDir;
      model = str(record(header.model).id);
      if (created) return [];
      created = true;
      return [make(line, undefined, {
        kind: "session_created", summary: "Motifcode task started",
        payload: { schemaVersion: 2, ...(model ? { model } : {}), ...(str(record(header.harness).version) ? { harnessVersion: record(header.harness).version } : {}) }
      })];
    }
    const seq = number(line.seq);
    if (line.v !== 2 || seq === undefined || !Number.isInteger(seq) || seq <= lastSeq || !str(line.runId) || !str(line.scopeId) || !["root", "subagent"].includes(String(line.scopeKind))) return [];
    // A different run belongs to another file; accept an explicit header only.
    if (created && line.runId !== runId) return [];
    if (!created) runId = str(line.runId)!;
    lastSeq = seq;
    const scope = scopeFor(line);
    const rec = record(line.record);
    const out: TraceEventInput[] = [];
    if (!created) {
      created = true;
      out.push(make(line, undefined, { kind: "session_created", summary: "Motifcode task started", payload: { schemaVersion: 2 } }));
    }
    const emit = (kind: TraceEventInput["kind"], summary: string, payload: UnknownRecord): void => { out.push(make(line, scope, { kind, summary, payload })); };
    if (rec.t === "scope_start") {
      if (scope.child) emit("agent_start", `Subagent started: ${scope.label ?? scope.id}`, { agentId: scope.id, ...(scope.label ? { agent: scope.label } : {}), ...(scope.parent ? { parentScopeId: scope.parent } : {}) });
      const task = str(rec.task);
      if (task) emit("message", "user prompt", { role: "user", text: task });
      return out;
    }
    if (rec.t === "scope_end") return [...out, ...finish(line, scope, record(rec.result))];
    if (rec.t === "resume") {
      emit("host_event", "Resumed Motifcode task", { event: "resume", ...(str(rec.previousRunId) ? { previousRunId: rec.previousRunId } : {}) });
      return out;
    }
    if (rec.t !== "event") return out;
    const event = record(rec.event);
    const type = str(event.type);
    switch (type) {
      case "session_start": {
        const nextModel = str(event.model);
        if (nextModel && model && model !== nextModel) emit("model_switched", `Model → ${nextModel}`, { model: nextModel });
        if (nextModel) model = nextModel;
        break;
      }
      case "turn_start": {
        const turn = number(event.turn);
        if (turn === undefined) break;
        if (scope.turn) emit("turn_end", "Turn ended", { reason: "next_turn" });
        scope.turn = `${runId}:${scope.id}:turn-${turn}`;
        scope.content = false;
        emit("turn_start", "Turn started", { turn });
        break;
      }
      case "content_delta":
      case "reasoning_delta": {
        const text = str(event.text);
        if (!text) break;
        if (type === "content_delta") scope.content = true;
        emit("message", type === "content_delta" ? "assistant response" : "assistant reasoning", { role: "assistant", chars: text.length, ...(type === "reasoning_delta" ? { reasoning: true } : {}), ...(model ? { model } : {}) });
        break;
      }
      case "usage": {
        const input = number(event.promptTokens);
        const output = number(event.completionTokens);
        const cached = number(event.cachedTokens);
        // Core's canonical token snapshots require a measured prompt count.
        // Keep partial reports outside that shape so output-only telemetry
        // cannot be mistaken for a measured zero-token prompt.
        const tokens = input !== undefined ? { input, ...(output !== undefined ? { output } : {}), ...(cached !== undefined ? { cache: { read: cached } } : {}) } : undefined;
        const cost = record(event.reportedCost);
        emit("message", "assistant usage", {
          role: "assistant", ...(model ? { model } : {}),
          ...(tokens ? { tokens } : {}),
          ...(input === undefined && output !== undefined ? { reportedCompletionTokens: output } : {}),
          ...(input === undefined && cached !== undefined ? { reportedCachedTokens: cached } : {}),
          ...(number(event.contextTokens) !== undefined ? { estimatedContextTokens: event.contextTokens } : {}),
          ...(number(event.requestMs) !== undefined ? { requestMs: event.requestMs } : {}),
          ...(cost.provider === "infron" && cost.unit === "credits" && number(cost.amount) !== undefined ? { reportedCost: { provider: "infron", unit: "credits", amount: cost.amount } } : {})
        });
        break;
      }
      case "tool_start": {
        const call = record(event.call);
        const id = str(call.id);
        const name = str(call.name);
        if (!id || !name) break;
        calls.set(`${scope.id}\0${id}`, { name, input: record(call.arguments) });
        bound(calls, MAX_PENDING_CALLS);
        emit("tool_call", `tool.call:${name}`, { tool: name, callID: id });
        break;
      }
      case "tool_end": {
        const id = str(event.id);
        const key = `${scope.id}\0${id}`;
        const call = calls.get(key);
        calls.delete(key);
        for (const partial of toolResult(call, event)) out.push(make(line, scope, partial));
        break;
      }
      case "plan":
        emit("todo_updated", "Updated plan", { ...(str(event.plan) ? { planChars: str(event.plan)!.length } : {}), ...(str(event.analysis) ? { analysisChars: str(event.analysis)!.length } : {}) });
        break;
      case "compaction":
        emit("context_compacted", "Context compacted", { ...(number(event.beforeTokens) !== undefined ? { beforeTokens: event.beforeTokens } : {}), ...(str(event.summary) ? { summaryChars: str(event.summary)!.length } : {}) });
        break;
      case "session_end": return [...out, ...finish(line, scope, event)];
      case "parse_failure":
        emit("host_event", "Motifcode parse failure", { event: type, ...(str(event.kind) ? { kind: event.kind } : {}), ...(typeof event.sample === "string" ? { sampleChars: event.sample.length } : {}) });
        break;
      case "notice":
      case "repair":
      case "channel_downgrade":
      case "loop_detected":
      case "hook":
      case "queue":
        emit("host_event", `Motifcode ${type.replaceAll("_", " ")}`, { event: type, ...event });
        break;
      // stream is display-only; prefix is character overlap, not cache telemetry.
      // reasoning_end and checkpoints would count the same content twice.
      default: break;
    }
    return out;
  }

  return { consume, prime: (line: MotifcodeJournalLine): void => { consume(line); } };
}

function toolResult(call: Call | undefined, event: UnknownRecord): PartialEvent[] {
  const name = call?.name ?? "unknown";
  const output = str(event.output) ?? "";
  const success = typeof event.ok === "boolean" ? event.ok : undefined;
  const common: UnknownRecord = { tool: name, ...(str(event.id) ? { callID: event.id } : {}), ...(success !== undefined ? { success } : {}), outputChars: output.length, ...(number(event.ms) !== undefined ? { durationMs: event.ms } : {}) };
  const fallback = (): PartialEvent[] => [{ kind: "tool_result", summary: success === false ? `${name} failed` : `Used ${name}`, payload: common }];
  if (!call) return fallback();
  const path = str(call.input.path);
  if (name === "bash") {
    const command = str(call.input.command);
    // ok supplies success, not an exact failing exit status. Only record the
    // latter when Motifcode includes its '(exit N)' sentinel in the output.
    const exitMatch = output.match(/^\(exit (-?\d+)\)$/);
    const exitCode = success === true ? 0 : exitMatch ? Number(exitMatch[1]) : undefined;
    const git = success === true && command ? gitKind(command) : undefined;
    return [{ kind: git ?? "bash", summary: command ? `Ran ${command}` : "Ran shell command", payload: { ...common, ...(command ? { command } : {}), ...(exitCode !== undefined ? { exitCode } : {}) } }];
  }
  if (success !== true) return fallback();
  if (name === "read" && path) return [{ kind: "file_read", summary: `Read ${path}`, payload: { ...common, path, chars: output.length } }];
  if (name === "write" && path) return [{ kind: output.startsWith("created ") ? "file_created" : "file_edit", summary: `Wrote ${path}`, payload: { ...common, path, ...(typeof call.input.content === "string" ? { chars: call.input.content.length } : {}) } }];
  if (name === "apply_patch") {
    const patch = str(call.input.patch);
    const changes = patch ? patchChanges(patch) : [];
    if (changes.length) return changes.map((change) => ({ kind: change.kind, summary: `Patched ${change.path}`, payload: { ...common, path: change.path, chars: change.chars } }));
  }
  if (name === "skill") return [{ kind: "command_run", summary: `Loaded skill ${str(call.input.name) ?? ""}`.trim(), payload: { ...common, ...(str(call.input.name) ? { command: call.input.name } : {}) } }];
  if (name === "mcp") return [{ kind: "tool_result", summary: `Used ${str(call.input.server) ?? "MCP"}: ${str(call.input.method) ?? "tool"}`, payload: { ...common, ...(str(call.input.server) ? { server: call.input.server } : {}), ...(str(call.input.method) ? { method: call.input.method } : {}) } }];
  return fallback();
}

function patchChanges(patch: string): { kind: "file_created" | "file_edit" | "file_deleted"; path: string; chars: number }[] {
  const changes: { kind: "file_created" | "file_edit" | "file_deleted"; path: string; chars: number }[] = [];
  // Motifcode executes git apply, so this is unified diff, not Codex's
  // *** Begin Patch format. Deletion headers name /dev/null on the right.
  const lines = patch.split(/\r?\n/);
  let current: (typeof changes)[number] | undefined;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      current = undefined;
      inHunk = false;
      continue;
    }
    // A removed '-- text' followed by an added '++ text' looks exactly like
    // file headers. Hunk position distinguishes that content from another file.
    const next = lines[i + 1];
    if ((!inHunk || (oldRemaining === 0 && newRemaining === 0))
      && line.startsWith("--- ") && next?.startsWith("+++ ")
      && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[i + 2] ?? "")) {
      const oldPath = diffPath(line.slice(4));
      const newPath = diffPath(next.slice(4));
      const path = newPath === "/dev/null" ? oldPath : newPath;
      current = undefined;
      if (path && path !== "/dev/null") {
        const kind = oldPath === "/dev/null" ? "file_created" : newPath === "/dev/null" ? "file_deleted" : "file_edit";
        current = { kind, path, chars: 0 };
        changes.push(current);
      }
      inHunk = false;
      i++;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (hunk) {
      oldRemaining = Number(hunk[1] ?? 1);
      newRemaining = Number(hunk[2] ?? 1);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (line.startsWith("-")) {
      oldRemaining--;
      current.chars += line.length - 1;
    } else if (line.startsWith("+")) {
      newRemaining--;
      current.chars += line.length - 1;
    } else if (line.startsWith(" ")) {
      oldRemaining--;
      newRemaining--;
    }
  }
  return changes;
}

function diffPath(value: string): string {
  const path = value.split("\t")[0]!.trim();
  if (path.startsWith('"')) {
    try { return String(JSON.parse(path)).replace(/^[ab]\//, ""); } catch { return path; }
  }
  return path.replace(/^[ab]\//, "");
}

function gitKind(command: string): "git_status" | "git_commit" | "git_push" | undefined {
  // Recognize an executed leading git command, not words inside echo, a grep
  // pattern, or quoted source. Compound commands can remain ordinary bash.
  if (/[;&|`$\r\n]/.test(command)) return undefined;
  if (/^\s*git\s+push\b/.test(command)) return "git_push";
  if (/^\s*git\s+commit\b/.test(command)) return "git_commit";
  if (/^\s*git\s+status\b/.test(command)) return "git_status";
  return undefined;
}

function bound<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) { const key = map.keys().next(); if (key.done) break; map.delete(key.value); }
}
function str(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
function record(value: unknown): UnknownRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}; }
function json(value: UnknownRecord): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }
