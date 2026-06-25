import type { TraceEvent } from "@agent-blackbox/core";

export type UnknownRecord = Record<string, unknown>;

/** A single parsed line from a Gajae-Code session JSONL file. */
export type GjcTranscriptLine = UnknownRecord;

export type TraceSink = {
  write(event: TraceEvent): Promise<void>;
};

export type GjcNormalizerContext = {
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
  agent?: { agentId: string; label?: string };
};

export type GjcRecorderOptions = {
  /** Root of Gajae-Code's session store. Default: ~/.gjc/agent/sessions. */
  sessionsDir?: string;
  homeDir?: string;
  /** Re-process files modified within this many days on startup (0 = no backfill). Default 0. */
  backfillDays?: number;
  /** Poll interval for appended lines, ms. Default 700. */
  pollMs?: number;
  rawStored?: boolean;
};
