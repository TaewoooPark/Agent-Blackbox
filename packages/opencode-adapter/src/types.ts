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
};

export type OpenCodeRecorderHooks = {
  event: (input: { event: unknown }) => Promise<void>;
  "tool.execute.before": (input: OpenCodeHookInput, output: OpenCodeHookOutput) => Promise<void>;
  "tool.execute.after": (input: OpenCodeHookInput, output: OpenCodeHookOutput) => Promise<void>;
};
