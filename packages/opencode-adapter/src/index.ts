import {
  normalizeOpenCodeEvent,
  normalizeToolAfter,
  normalizeToolBefore,
  type OpenCodeNormalizerContext
} from "./normalize.js";
import { createTraceSink, resolveRecorderOptions } from "./sink.js";
import type {
  OpenCodePluginContext,
  OpenCodeRecorderHooks,
  OpenCodeRecorderOptions,
  TraceSink
} from "./types.js";

export const AGENT_BLACKBOX_OPENCODE_ADAPTER_VERSION = "0.1.0";

export function describeOpenCodeAdapter(): string {
  return "Agent-Blackbox OpenCode adapter: thin host-event capture layer.";
}

export async function createOpenCodeRecorder(
  context: OpenCodePluginContext,
  options: OpenCodeRecorderOptions = {}
): Promise<OpenCodeRecorderHooks> {
  const resolved = resolveRecorderOptions(options);
  const directory = context.directory ?? process.cwd();
  const runId = resolved.runId ?? `opencode-${Date.now()}`;
  const sink = createTraceSink({
    directory,
    ...(resolved.daemonUrl ? { daemonUrl: resolved.daemonUrl } : {}),
    ...(resolved.eventsFile ? { eventsFile: resolved.eventsFile } : {}),
    ...(resolved.sink ? { sink: resolved.sink } : {})
  });
  const factory = createOpenCodeEventFactory({
    runId,
    sink,
    defaultSessionId: "unknown-session",
    ...(resolved.homeDir ? { homeDir: resolved.homeDir } : {}),
    projectDir: resolved.projectDir ?? directory,
    rawStored: resolved.rawStored ?? false
  });

  return {
    event: async ({ event }) => {
      await factory.writeEvent(event);
    },
    "tool.execute.before": async (input, output) => {
      await factory.writeToolBefore(input, output);
    },
    "tool.execute.after": async (input, output) => {
      await factory.writeToolAfter(input, output);
    }
  };
}

export function createOpenCodePlugin(options: OpenCodeRecorderOptions = {}) {
  return async (context: OpenCodePluginContext): Promise<OpenCodeRecorderHooks> =>
    createOpenCodeRecorder(context, options);
}

export const AgentBlackboxOpenCode = createOpenCodePlugin();

function createOpenCodeEventFactory(options: {
  runId: string;
  sink: TraceSink;
  defaultSessionId: string;
  homeDir?: string;
  projectDir?: string;
  rawStored: boolean;
}) {
  let seq = 0;
  const nextContext = (): OpenCodeNormalizerContext => {
    seq += 1;
    return {
      runId: options.runId,
      seq,
      defaultSessionId: options.defaultSessionId,
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
      rawStored: options.rawStored
    };
  };

  return {
    async writeEvent(rawEvent: unknown): Promise<void> {
      await options.sink.write(normalizeOpenCodeEvent(rawEvent, nextContext()));
    },
    async writeToolBefore(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
      await options.sink.write(normalizeToolBefore(input, output, nextContext()));
    },
    async writeToolAfter(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
      await options.sink.write(normalizeToolAfter(input, output, nextContext()));
    }
  };
}

export type {
  OpenCodeHookInput,
  OpenCodeHookOutput,
  OpenCodePluginContext,
  OpenCodeRecorderHooks,
  OpenCodeRecorderOptions,
  TraceSink
} from "./types.js";
export {
  normalizeOpenCodeEvent,
  normalizeToolAfter,
  normalizeToolBefore
} from "./normalize.js";
export {
  createFileTraceSink,
  createHttpTraceSink,
  createTraceSink
} from "./sink.js";
