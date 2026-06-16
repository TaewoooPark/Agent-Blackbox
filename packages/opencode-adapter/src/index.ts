import {
  normalizeOpenCodeEvent,
  normalizeSyntheticUserPrompt,
  normalizeToolAfter,
  normalizeToolBefore,
  shouldRecordOpenCodeEvent,
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
  const cliPrompt = resolved.cliPrompt ?? detectOpenCodeRunPrompt(process.argv);
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
    ...(cliPrompt ? { cliPrompt } : {}),
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
  cliPrompt?: string;
  rawStored: boolean;
}) {
  let seq = 0;
  const promptSessions = new Set<string>();
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
      if (!shouldRecordOpenCodeEvent(rawEvent)) {
        return;
      }
      const event = normalizeOpenCodeEvent(rawEvent, nextContext());
      await options.sink.write(event);
      if (options.cliPrompt && event.kind === "session_created" && !promptSessions.has(event.sessionId)) {
        promptSessions.add(event.sessionId);
        await options.sink.write(normalizeSyntheticUserPrompt(options.cliPrompt, event, nextContext()));
      }
    },
    async writeToolBefore(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
      await options.sink.write(normalizeToolBefore(input, output, nextContext()));
    },
    async writeToolAfter(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
      await options.sink.write(normalizeToolAfter(input, output, nextContext()));
    }
  };
}

export function detectOpenCodeRunPrompt(argv: string[]): string | undefined {
  const runIndex = argv.indexOf("run");
  const promptFlagIndex = argv.indexOf("--prompt");
  if (promptFlagIndex >= 0 && argv[promptFlagIndex + 1]) {
    return cleanCliPrompt(argv[promptFlagIndex + 1]);
  }
  if (runIndex < 0) return undefined;

  const valueFlags = new Set([
    "-m",
    "--model",
    "-s",
    "--session",
    "--dir",
    "--port",
    "--hostname",
    "--log-level",
    "--mdns-domain",
    "--agent",
    "--prompt"
  ]);
  const messageParts: string[] = [];
  for (let index = runIndex + 1; index < argv.length; index += 1) {
    const part = argv[index]!;
    if (valueFlags.has(part)) {
      index += 1;
      continue;
    }
    if (part.startsWith("--")) continue;
    messageParts.push(part);
  }
  return cleanCliPrompt(messageParts.join(" "));
}

function cleanCliPrompt(value: string | undefined): string | undefined {
  const prompt = value?.trim();
  if (!prompt) return undefined;
  return prompt.length > 2000 ? `${prompt.slice(0, 1997)}...` : prompt;
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
