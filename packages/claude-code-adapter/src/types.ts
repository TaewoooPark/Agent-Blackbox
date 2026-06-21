import type { TraceEvent } from "@agent-blackbox/core";

export type UnknownRecord = Record<string, unknown>;

/** A single parsed line from a Claude Code transcript JSONL file. */
export type ClaudeTranscriptLine = UnknownRecord;

export type TraceSink = {
  write(event: TraceEvent): Promise<void>;
};

export type ClaudeNormalizerContext = {
  /**
   * Fallback session id when a line carries none. runId is derived per line from
   * `sessionId` (which a subagent transcript inherits from its parent), so no
   * run id is threaded through the context.
   */
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
  /**
   * Present when the source file is a subagent transcript (`agent-<id>.jsonl`,
   * every line `isSidechain:true`). Forks a lane (agentId) under the parent run.
   */
  agent?: { agentId: string; label?: string };
};

export type ClaudeRecorderOptions = {
  /** Root of Claude Code's per-project transcripts. Default: ~/.claude/projects. */
  projectsDir?: string;
  homeDir?: string;
  /** Re-process files modified within this many days on startup (0 = no backfill). Default 2. */
  backfillDays?: number;
  /** Poll interval for appended lines, ms. Default 700. */
  pollMs?: number;
  rawStored?: boolean;
};
