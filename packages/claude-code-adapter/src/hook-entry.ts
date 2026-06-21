// The command Claude Code spawns for each installed hook. Reads the hook JSON on
// stdin, actuates (in-run read-dedup + working-set injection), and persists a tiny
// per-session state file. Invoked as: `node hook-entry.js <Event> agent-blackbox-hook`.
//
// IRON RULE: this must never break the user's run. Any error → exit 0 with no
// output (the tool proceeds normally). It only ever *helps*.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  bumpGeneration,
  buildWorkingSet,
  decideRead,
  emptyState,
  recordCommand,
  recordEdit,
  recordRead,
  type HookState
} from "./hooks.js";

type HookInput = {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
};

main();

function main(): void {
  try {
    const event = process.argv[2];
    if (!event) return;
    const input = readInput();
    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
    if (!sessionId) return;
    switch (event) {
      case "PreToolUse":
        return onPreToolUse(sessionId, input);
      case "PostToolUse":
        return onPostToolUse(sessionId, input);
      case "UserPromptSubmit":
        return onUserPromptSubmit(sessionId);
      case "PreCompact":
        return mutate(sessionId, bumpGeneration);
      case "SessionEnd":
        return cleanup(sessionId);
      default:
        return;
    }
  } catch {
    // Swallow everything — a broken optimizer must not disturb the agent.
  }
}

// --- events -----------------------------------------------------------------

function onPreToolUse(sessionId: string, input: HookInput): void {
  if (lower(input.tool_name) !== "read") return; // only Reads are deduped
  const path = fullReadPath(input);
  if (!path) return; // partial reads (offset/limit) are never deduped
  const mtime = mtimeMs(path);
  if (mtime === undefined) return; // file gone/unreadable → let the tool handle it
  const state = loadState(sessionId);
  const decision = decideRead(state, path, mtime);
  if (decision.deny) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason
      }
    });
  }
}

function onPostToolUse(sessionId: string, input: HookInput): void {
  const tool = lower(input.tool_name);
  mutate(sessionId, (state) => {
    if (tool === "read") {
      const path = fullReadPath(input);
      const mtime = path ? mtimeMs(path) : undefined;
      if (path && mtime !== undefined) recordRead(state, path, mtime);
    } else if (tool === "edit" || tool === "multiedit" || tool === "write" || tool === "notebookedit") {
      const path = filePath(input);
      if (path) recordEdit(state, path);
    } else if (tool === "bash") {
      const command = strInput(input, "command");
      if (command) recordCommand(state, command);
    }
  });
}

function onUserPromptSubmit(sessionId: string): void {
  const block = buildWorkingSet(loadState(sessionId));
  if (block) {
    emit({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } });
  }
}

// --- state I/O (best-effort, atomic write) ----------------------------------

function statePath(sessionId: string): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(base, "agent-blackbox", "hooks", `${safe}.json`);
}

function loadState(sessionId: string): HookState {
  try {
    const raw = JSON.parse(readFileSync(statePath(sessionId), "utf8")) as Partial<HookState>;
    return {
      gen: typeof raw.gen === "number" ? raw.gen : 0,
      seq: typeof raw.seq === "number" ? raw.seq : 0,
      reads: isRecord(raw.reads) ? (raw.reads as HookState["reads"]) : {},
      files: isRecord(raw.files) ? (raw.files as HookState["files"]) : {},
      commands: Array.isArray(raw.commands) ? raw.commands.filter((c): c is string => typeof c === "string") : []
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
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, target); // atomic swap so a concurrent hook never reads a half-written file
  } catch {
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

// --- helpers ----------------------------------------------------------------

function readInput(): HookInput {
  const raw = readFileSync(0, "utf8"); // fd 0 = stdin (Claude Code pipes the hook JSON)
  return JSON.parse(raw) as HookInput;
}

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload));
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function filePath(input: HookInput): string | undefined {
  const fp = strInput(input, "file_path") ?? strInput(input, "path") ?? strInput(input, "notebook_path");
  if (!fp) return undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  return isAbsolute(fp) ? fp : resolve(cwd, fp);
}

// A *full* Read only (no offset/limit) — partial reads serve different bytes than
// the whole file, so they're neither recorded nor deduped.
function fullReadPath(input: HookInput): string | undefined {
  const args = input.tool_input;
  if (isRecord(args) && (typeof args.offset === "number" || typeof args.limit === "number")) return undefined;
  return filePath(input);
}

function strInput(input: HookInput, key: string): string | undefined {
  const args = input.tool_input;
  if (!isRecord(args)) return undefined;
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
