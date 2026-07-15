export const AGENT_BLACKBOX_CODEX_ADAPTER_VERSION = "0.1.0";

export function describeCodexAdapter(): string {
  return "Agent-Blackbox Codex adapter: session transcript-tailing capture layer.";
}

export { createCodexNormalizer } from "./normalize.js";
export { defaultCodexSessionsDir, startCodexTailer } from "./tailer.js";
export {
  ABB_CODEX_HOOK_MARKER,
  codexHookSpecs,
  hasAbbCodexHooks,
  mergeAbbCodexHooks,
  removeAbbCodexHooks,
  type CodexHooksConfig
} from "./hooks.js";
export type {
  CodexNormalizerContext,
  CodexRecorderOptions,
  CodexTranscriptLine,
  TraceSink
} from "./types.js";
