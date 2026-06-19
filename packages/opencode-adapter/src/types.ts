import type { TraceEvent } from "@agent-blackbox/core";

export type UnknownRecord = Record<string, unknown>;

export type OpenCodePluginContext = {
  project?: unknown;
  directory?: string;
  worktree?: string;
  client?: unknown;
  $?: unknown;
};

export type OpenCodeHookInput = UnknownRecord;
export type OpenCodeHookOutput = UnknownRecord;

export type TraceSink = {
  write(event: TraceEvent): Promise<void>;
};

export type OpenCodeRecorderOptions = {
  runId?: string;
  daemonUrl?: string;
  eventsFile?: string;
  cliPrompt?: string;
  sink?: TraceSink;
  homeDir?: string;
  projectDir?: string;
  rawStored?: boolean;
  // Opt-in: let the recorder also ACT in-run — serve unchanged/edited re-reads as
  // a no-op/diff and inject a working-set memory block. Off by default (pure observer).
  optimize?: boolean;
};

export type OpenCodeRecorderHooks = {
  event: (input: { event: unknown }) => Promise<void>;
  "tool.execute.before": (input: OpenCodeHookInput, output: OpenCodeHookOutput) => Promise<void>;
  "tool.execute.after": (input: OpenCodeHookInput, output: OpenCodeHookOutput) => Promise<void>;
  "experimental.session.compacting"?: (input: OpenCodeHookInput, output: OpenCodeHookOutput) => Promise<void>;
  "experimental.chat.system.transform"?: (input: OpenCodeHookInput, output: OpenCodeHookOutput) => Promise<void>;
};
