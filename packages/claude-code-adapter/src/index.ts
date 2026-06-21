export const AGENT_BLACKBOX_CLAUDE_CODE_ADAPTER_VERSION = "0.1.0";

export function describeClaudeCodeAdapter(): string {
  return "Agent-Blackbox Claude Code adapter: transcript-tailing capture layer.";
}

export { createClaudeNormalizer } from "./normalize.js";
export { defaultProjectsDir, startClaudeCodeTailer } from "./tailer.js";
export type {
  ClaudeNormalizerContext,
  ClaudeRecorderOptions,
  ClaudeTranscriptLine,
  TraceSink
} from "./types.js";
