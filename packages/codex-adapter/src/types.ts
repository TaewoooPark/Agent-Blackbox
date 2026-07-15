import type { TraceEvent } from "@agent-blackbox/core";

export type UnknownRecord = Record<string, unknown>;
export type CodexTranscriptLine = UnknownRecord;

export type TraceSink = {
  write(event: TraceEvent): Promise<void>;
};

export type CodexNormalizerContext = {
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
};

export type CodexRecorderOptions = {
  /** Root of Codex's rollout store. Default: $CODEX_HOME/sessions or ~/.codex/sessions. */
  sessionsDir?: string;
  homeDir?: string;
  /** Re-process files modified within this many days on startup (0 = no backfill). Default 0. */
  backfillDays?: number;
  /** Poll interval for appended lines, ms. Default 700. */
  pollMs?: number;
  rawStored?: boolean;
};
