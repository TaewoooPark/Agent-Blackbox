#!/usr/bin/env node
// Best-effort Codex optimizer hook. It never records content and never fails a
// Codex run: any parse/I/O problem exits successfully with no output.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
};

type ReadRecord = { mtimeMs: number; gen: number };
type HookState = {
  gen: number;
  reads: Record<string, ReadRecord>;
  files: Record<string, { reads: number; edits: number }>;
  commands: string[];
};

function main(): void {
  try {
    const event = process.argv[2];
    if (!event) return;
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const output = runCodexHook(event, input);
    if (output !== undefined) emit(output);
  } catch (error) {
    debug(error);
    // An optimizer must be fail-open.
  }
}

export function runCodexHook(event: string, input: HookInput): unknown | undefined {
  if (!input.session_id) return undefined;
  if (event === "SessionStart") cleanup(input.session_id);
  else if (event === "PreToolUse") return onPreToolUse(input.session_id, input);
  else if (event === "PostToolUse") onPostToolUse(input.session_id, input);
  else if (event === "UserPromptSubmit") return onUserPromptSubmit(input.session_id);
  else if (event === "PreCompact") mutate(input.session_id, (state) => { state.gen += 1; });
  return undefined;
}

function onPreToolUse(sessionId: string, input: HookInput): unknown | undefined {
  const path = fullReadPath(input);
  if (!path) return undefined;
  const mtime = mtimeMs(path);
  if (mtime === undefined) return undefined;
  const state = loadState(sessionId);
  const previous = state.reads[path];
  if (previous && previous.gen === state.gen && previous.mtimeMs === mtime) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[Agent-Blackbox] ${path} is unchanged and already in this session's context; reuse it instead of reading it again.`
      }
    };
  }
  return undefined;
}

function onPostToolUse(sessionId: string, input: HookInput): void {
  const tool = normalizedTool(input);
  mutate(sessionId, (state) => {
    const readPath = fullReadPath(input);
    if (readPath) {
      const mtime = mtimeMs(readPath);
      if (mtime !== undefined) {
        state.reads[readPath] = { mtimeMs: mtime, gen: state.gen };
        const file = state.files[readPath] ?? { reads: 0, edits: 0 };
        file.reads += 1;
        state.files[readPath] = file;
      }
    }
    for (const path of tool.editedPaths) {
      delete state.reads[path];
      const file = state.files[path] ?? { reads: 0, edits: 0 };
      file.edits += 1;
      state.files[path] = file;
    }
    if (tool.command && isReusableCommand(tool.command) && !state.commands.includes(tool.command) && state.commands.length < 20) {
      state.commands.push(tool.command);
    }
  });
}

function onUserPromptSubmit(sessionId: string): unknown | undefined {
  const state = loadState(sessionId);
  const read = Object.entries(state.files).filter(([, value]) => value.reads > 0 && value.edits === 0).map(([path]) => baseName(path));
  const edited = Object.entries(state.files).filter(([, value]) => value.edits > 0).map(([path]) => baseName(path));
  if (read.length === 0 && edited.length === 0 && state.commands.length === 0) return undefined;
  const lines = ["[Agent-Blackbox working set — already done this session; reuse it, don't redo it]"];
  if (read.length > 0) lines.push(`Files already read: ${cap(read, 12).join(", ")}`);
  if (edited.length > 0) lines.push(`Files edited: ${cap(edited, 12).join(", ")}`);
  if (state.commands.length > 0) lines.push(`Commands already run: ${cap(state.commands, 10).join(" | ")}`);
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } };
}

function normalizedTool(input: HookInput): { command?: string; editedPaths: string[] } {
  const name = typeof input.tool_name === "string" ? input.tool_name.toLowerCase() : "";
  const object = isRecord(input.tool_input) ? input.tool_input : {};
  if (["bash", "shell", "shell_command", "exec_command"].includes(name)) {
    const command = stringField(object, "command") ?? stringField(object, "cmd");
    return { ...(command ? { command } : {}), editedPaths: [] };
  }
  if (["edit", "write", "apply_patch"].includes(name)) {
    const path = stringField(object, "file_path") ?? stringField(object, "path");
    const patch = stringField(object, "patch") ?? (typeof input.tool_input === "string" ? input.tool_input : undefined);
    return { editedPaths: path ? [absolute(path, input.cwd)] : patch ? patchPaths(patch, input.cwd) : [] };
  }
  if (name === "exec" && typeof input.tool_input === "string") return parseExecCode(input.tool_input, input.cwd);
  return { editedPaths: [] };
}

function parseExecCode(code: string, cwd: string | undefined): { command?: string; editedPaths: string[] } {
  const patch = extractJsString(code, /(?:const|let)\s+patch\s*=\s*("(?:\\.|[^"\\])*")/s);
  if (code.includes("tools.apply_patch") || code.includes("apply_patch(")) return { editedPaths: patch ? patchPaths(patch, cwd) : [] };
  const command = extractJsString(code, /(?:\bcmd|"cmd")\s*:\s*("(?:\\.|[^"\\])*")/s);
  return { ...(command ? { command } : {}), editedPaths: [] };
}

// Only a single, full `cat file` is denied on repeat. Ranged reads, compound
// commands, globs, pipes, and any ambiguous syntax always proceed.
function fullReadPath(input: HookInput): string | undefined {
  const tool = normalizedTool(input);
  const command = tool.command?.trim();
  if (!command || /(?:&&|\|\||[;|<>`$])/.test(command)) return undefined;
  const match = command.match(/^cat\s+(?:--\s+)?("[^"]+"|'[^']+'|[^\s]+)$/);
  if (!match?.[1]) return undefined;
  const path = match[1].replace(/^(?:"|')|(?:"|')$/g, "");
  if (!path || /[*?\[]/.test(path)) return undefined;
  return absolute(path, input.cwd);
}

function patchPaths(patch: string, cwd: string | undefined): string[] {
  const out: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const path = match[1]?.trim();
    if (path) out.push(absolute(path, cwd));
  }
  return out;
}

function absolute(path: string, cwd: string | undefined): string {
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path);
}

function statePath(sessionId: string): string {
  // Codex command hooks execute under the active sandbox. Its temporary root
  // is writable even when ~/.local is not, and this state only needs to live
  // for the duration of a resumable session.
  return join(tmpdir(), "agent-blackbox", "codex-hooks", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function emptyState(): HookState {
  return { gen: 0, reads: {}, files: {}, commands: [] };
}

function loadState(sessionId: string): HookState {
  try {
    const raw = JSON.parse(readFileSync(statePath(sessionId), "utf8")) as Partial<HookState>;
    return {
      gen: typeof raw.gen === "number" ? raw.gen : 0,
      reads: isRecord(raw.reads) ? (raw.reads as HookState["reads"]) : {},
      files: isRecord(raw.files) ? (raw.files as HookState["files"]) : {},
      commands: Array.isArray(raw.commands) ? raw.commands.filter((value): value is string => typeof value === "string") : []
    };
  } catch {
    return emptyState();
  }
}

function mutate(sessionId: string, fn: (state: HookState) => void): void {
  const state = loadState(sessionId);
  fn(state);
  const target = statePath(sessionId);
  try {
    mkdirSync(join(target, ".."), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), "utf8");
    renameSync(temp, target);
  } catch (error) {
    debug(error);
    // best-effort
  }
}

function cleanup(sessionId: string): void {
  try {
    rmSync(statePath(sessionId), { force: true });
  } catch {
    // best-effort
  }
}

const NAV_VERBS = new Set(["ls", "pwd", "cat", "find", "grep", "rg", "fd", "head", "tail", "sed", "wc", "sort", "uniq", "stat"]);

function isReusableCommand(command: string): boolean {
  const verb = command.trim().split(/\s+/)[0] ?? "";
  return Boolean(verb) && !NAV_VERBS.has(verb);
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
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

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function cap<T>(items: T[], max: number): (T | string)[] {
  return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function debug(error: unknown): void {
  if (process.env.AGENT_BLACKBOX_HOOK_DEBUG !== "1") return;
  process.stderr.write(`[agent-blackbox-codex-hook] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
