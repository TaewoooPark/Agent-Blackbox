// Codex global hook configuration helpers. Recording itself uses the transcript
// tailer; these hooks are installed only for the opt-in in-run optimizer.

export const ABB_CODEX_HOOK_MARKER = "agent-blackbox-codex-hook";

type HookCommand = { type: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCommand[] };
type HooksByEvent = Record<string, HookGroup[]>;
export type CodexHooksConfig = Record<string, unknown> & { hooks?: HooksByEvent };

export type CodexHookSpec = { event: string; matcher?: string };

export function codexHookSpecs(): CodexHookSpec[] {
  return [
    { event: "SessionStart", matcher: "^startup$" },
    { event: "PreToolUse", matcher: "^(Bash|apply_patch|Edit|Write)$" },
    { event: "PostToolUse", matcher: "^(Bash|apply_patch|Edit|Write)$" },
    { event: "UserPromptSubmit" },
    { event: "PreCompact" }
  ];
}

export function mergeAbbCodexHooks(config: CodexHooksConfig, invocation: string): CodexHooksConfig {
  const next: CodexHooksConfig = { ...config };
  const hooks: HooksByEvent = isRecord(config.hooks) ? { ...(config.hooks as HooksByEvent) } : {};
  for (const spec of codexHookSpecs()) {
    const current = hooks[spec.event];
    const kept = (Array.isArray(current) ? current : []).filter((group) => !isAbbGroup(group));
    kept.push({
      ...(spec.matcher ? { matcher: spec.matcher } : {}),
      hooks: [{ type: "command", command: `${invocation} ${spec.event} ${ABB_CODEX_HOOK_MARKER}`, timeout: 10 }]
    });
    hooks[spec.event] = kept;
  }
  next.hooks = hooks;
  return next;
}

export function removeAbbCodexHooks(config: CodexHooksConfig): CodexHooksConfig {
  if (!isRecord(config.hooks)) return config;
  const next: CodexHooksConfig = { ...config };
  const hooks: HooksByEvent = {};
  for (const [event, groups] of Object.entries(config.hooks as HooksByEvent)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((group) => !isAbbGroup(group));
    if (kept.length > 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

export function hasAbbCodexHooks(config: CodexHooksConfig): boolean {
  if (!isRecord(config.hooks)) return false;
  return Object.values(config.hooks as HooksByEvent).some((groups) => Array.isArray(groups) && groups.some(isAbbGroup));
}

function isAbbGroup(group: unknown): boolean {
  return (
    isRecord(group) &&
    Array.isArray((group as HookGroup).hooks) &&
    (group as HookGroup).hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes(ABB_CODEX_HOOK_MARKER))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
