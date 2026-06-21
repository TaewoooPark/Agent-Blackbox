// Pure, dependency-free actuator logic for the Claude Code hook entry. Kept free
// of @agent-blackbox/core (and any import) so the bundled hook stays tiny and
// starts fast — it is spawned once per matched tool call.

// Appended to every command we write into settings.json so uninstall can find and
// strip exactly our entries, leaving the user's own hooks untouched. It rides as an
// ignored extra argv to the hook (shell-independent — not a comment).
export const ABB_HOOK_MARKER = "agent-blackbox-hook";

type HookCommand = { type: "command"; command: string };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HooksByEvent = Record<string, HookGroup[]>;
export type Settings = Record<string, unknown> & { hooks?: HooksByEvent };

export type AbbHookSpec = { event: string; matcher?: string };

// The hook events ABB installs, each scoped (where applicable) to the tools the
// actuator cares about so the hook isn't spawned for unrelated tool calls.
export function abbHookSpecs(): AbbHookSpec[] {
  return [
    { event: "PreToolUse", matcher: "Read|Edit|MultiEdit|Write|Bash" },
    { event: "PostToolUse", matcher: "Read|Edit|MultiEdit|Write|Bash" },
    { event: "UserPromptSubmit" },
    { event: "PreCompact" },
    { event: "SessionEnd" }
  ];
}

function isAbbGroup(group: unknown): boolean {
  return (
    isRecord(group) &&
    Array.isArray((group as HookGroup).hooks) &&
    (group as HookGroup).hooks.some((h) => isRecord(h) && typeof h.command === "string" && h.command.includes(ABB_HOOK_MARKER))
  );
}

/**
 * Merge ABB's hook entries into a parsed settings.json, preserving every other key
 * AND the user's own hooks. Idempotent: re-running first strips our prior entries,
 * so the daemon URL / invocation can be re-stamped without piling up duplicates.
 * `invocation` is the command prefix, e.g. `node /abs/hook-entry.js`.
 */
export function mergeAbbHooks(settings: Settings, invocation: string): Settings {
  const next: Settings = { ...settings };
  const hooks: HooksByEvent = isRecord(settings.hooks) ? { ...(settings.hooks as HooksByEvent) } : {};
  for (const spec of abbHookSpecs()) {
    const current = hooks[spec.event];
    const kept = (Array.isArray(current) ? current : []).filter((g) => !isAbbGroup(g)); // drop our own prior entries
    kept.push({
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command: `${invocation} ${spec.event} ${ABB_HOOK_MARKER}` }]
    });
    hooks[spec.event] = kept;
  }
  next.hooks = hooks;
  return next;
}

/** Remove only ABB's hook entries, leaving the user's hooks and other keys intact. */
export function removeAbbHooks(settings: Settings): Settings {
  if (!isRecord(settings.hooks)) return settings;
  const next: Settings = { ...settings };
  const hooks: HooksByEvent = {};
  for (const [event, groups] of Object.entries(settings.hooks as HooksByEvent)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isAbbGroup(g));
    if (kept.length > 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks; // don't leave an empty hooks object we introduced
  return next;
}

export function hasAbbHooks(settings: Settings): boolean {
  if (!isRecord(settings.hooks)) return false;
  return Object.values(settings.hooks as HooksByEvent).some((groups) => Array.isArray(groups) && groups.some(isAbbGroup));
}

// ---- in-run actuator state (per session) ----------------------------------

export type ReadRecord = { mtimeMs: number; gen: number; seq: number };
export type HookState = {
  gen: number; // bumped on every compaction → invalidates "still in context"
  seq: number;
  reads: Record<string, ReadRecord>;
  files: Record<string, { reads: number; edits: number }>;
  commands: string[];
};

export function emptyState(): HookState {
  return { gen: 0, seq: 0, reads: {}, files: {}, commands: [] };
}

/**
 * Decide whether a re-read is safe to skip. DENY only when we're certain the model
 * still holds identical bytes: same session (state is per-session), same compaction
 * generation (content wasn't dropped), and the file is byte-for-byte unchanged on
 * disk (mtime). An edit since the read clears the record (see recordEdit), so a
 * surviving record also means "not edited since". Any doubt → allow the read.
 */
export function decideRead(state: HookState, path: string, mtimeMs: number): { deny: true; reason: string } | { deny: false } {
  const record = state.reads[path];
  if (!record) return { deny: false };
  if (record.gen !== state.gen) return { deny: false }; // compaction since → content may be gone
  if (record.mtimeMs !== mtimeMs) return { deny: false }; // changed on disk
  return {
    deny: true,
    reason:
      `[Agent-Blackbox] You already read ${path} earlier this session and it is unchanged — ` +
      `reuse the copy already in your context instead of re-reading it.`
  };
}

export function recordRead(state: HookState, path: string, mtimeMs: number): void {
  state.seq += 1;
  state.reads[path] = { mtimeMs, gen: state.gen, seq: state.seq };
  const file = state.files[path] ?? { reads: 0, edits: 0 };
  file.reads += 1;
  state.files[path] = file;
}

export function recordEdit(state: HookState, path: string): void {
  state.seq += 1;
  delete state.reads[path]; // a later read of this path must NOT be deduped
  const file = state.files[path] ?? { reads: 0, edits: 0 };
  file.edits += 1;
  state.files[path] = file;
}

export function recordCommand(state: HookState, command: string): void {
  const cmd = command.trim();
  if (!cmd || !isReusableCommand(cmd) || state.commands.includes(cmd)) return;
  if (state.commands.length < 20) state.commands.push(cmd);
}

export function bumpGeneration(state: HookState): void {
  state.gen += 1;
}

// Pin build/test/run commands worth reusing — not read-only exploration, which the
// model should still do fresh against the current tree.
const NAV_VERBS = new Set([
  "ls", "pwd", "cat", "cd", "echo", "find", "grep", "rg", "fd", "head", "tail", "which",
  "env", "tree", "stat", "wc", "sort", "uniq", "clear", "sleep", "true", "false", "man",
  "less", "more", "open", "code", "printf", "date"
]);

export function isReusableCommand(command: string): boolean {
  const verb = command.trim().split(/\s+/)[0] ?? "";
  return verb.length > 0 && !NAV_VERBS.has(verb);
}

/**
 * A compact, purely-additive working-set block injected at UserPromptSubmit: it
 * reminds the model what it has already read/edited/verified this session so it
 * doesn't redo the work. Never denies anything — safe to always inject.
 */
export function buildWorkingSet(state: HookState): string | null {
  const read = Object.entries(state.files)
    .filter(([, f]) => f.reads > 0 && f.edits === 0)
    .map(([path]) => baseName(path));
  const edited = Object.entries(state.files)
    .filter(([, f]) => f.edits > 0)
    .map(([path]) => baseName(path));
  if (read.length === 0 && edited.length === 0 && state.commands.length === 0) return null;
  const lines = ["[Agent-Blackbox working set — already done this session; reuse it, don't redo it]"];
  if (read.length > 0) lines.push(`Files already read (don't re-read unchanged): ${cap(read, 12).join(", ")}`);
  if (edited.length > 0) lines.push(`Files edited: ${cap(edited, 12).join(", ")}`);
  if (state.commands.length > 0) lines.push(`Commands already run this session (reuse if still applicable): ${cap(state.commands, 10).join(" | ")}`);
  return lines.join("\n");
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function cap<T>(items: T[], max: number): (T | string)[] {
  return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
