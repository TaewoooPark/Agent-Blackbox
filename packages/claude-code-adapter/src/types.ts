import type { TraceEvent } from "@agent-blackbox/core";

export type UnknownRecord = Record<string, unknown>;

/** A single parsed line from a Claude Code transcript JSONL file. */
export type ClaudeTranscriptLine = UnknownRecord;

export type TraceSink = {
  write(event: TraceEvent): Promise<void>;
};

/**
 * Linkage the tailer extracts from a parent session's `Task`/`Agent` tool result
 * so it can attribute a separate `agent-<id>.jsonl` transcript to the right
 * subagent lane under the parent run.
 */
export type SubagentSpawn = {
  agentId: string;
  /** Absolute path of the subagent's own transcript, when the harness writes one. */
  outputFile?: string;
  label?: string;
  parentSessionId: string;
  parentRunId: string;
};

export type ClaudeNormalizerContext = {
  /** Run the events belong to. Main session: its own sessionId. Subagent: the parent run's id. */
  runId: string;
  /** Fallback session id when a line carries none. */
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
  /**
   * Present when the source file is a subagent transcript (every line is
   * `isSidechain:true`). All emitted events are stamped onto this subagent lane.
   */
  agent?: { agentId: string; parentSessionId: string; label?: string };
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
