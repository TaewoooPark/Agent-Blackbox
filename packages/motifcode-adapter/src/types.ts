import type { TraceEvent } from "@agent-blackbox/core";

export type UnknownRecord = Record<string, unknown>;
export type MotifcodeJournalLine = UnknownRecord;

export type TraceSink = { write(event: TraceEvent): Promise<void> };

export type MotifcodeNormalizerContext = {
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
};

export type MotifcodeRecorderOptions = {
  /** Default: <projectDir or current directory>/.motif/sessions. */
  sessionsDir?: string;
  projectDir?: string;
  homeDir?: string;
  /** Re-process journals modified within this many days (0 = no backfill). */
  backfillDays?: number;
  /** Poll interval in milliseconds. Default 700. */
  pollMs?: number;
  rawStored?: boolean;
};
