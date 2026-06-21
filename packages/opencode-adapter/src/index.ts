import type { TraceEvent } from "@agent-blackbox/core";
import {
  normalizeOpenCodeEvent,
  normalizeSyntheticUserPrompt,
  normalizeToolAfter,
  normalizeToolBefore,
  shouldRecordOpenCodeEvent,
  subagentSessionFromEvent,
  type OpenCodeNormalizerContext
} from "./normalize.js";
import {
  buildWorkingSetBlock,
  decideReadServe,
  hashContent,
  isReadTool,
  isReusableCommand,
  readArgPath,
  type ReadCacheEntry,
  type WorkingSetFile
} from "./optimize.js";
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

// No-op hooks (same shape) for when recording is intentionally disabled.
function noopRecorderHooks(): OpenCodeRecorderHooks {
  return {
    event: async () => {},
    "tool.execute.before": async () => {},
    "tool.execute.after": async () => {},
    "experimental.session.compacting": async () => {},
    "experimental.chat.system.transform": async () => {}
  };
}

export async function createOpenCodeRecorder(
  context: OpenCodePluginContext,
  options: OpenCodeRecorderOptions = {}
): Promise<OpenCodeRecorderHooks> {
  // A daemon-spawned `opencode run` (e.g. generating suggestions) would otherwise
  // be captured by the globally-installed recorder, adding a trivial run that
  // hijacks "latest run" and resets the shown score. Opt out via env.
  if (process.env.AGENT_BLACKBOX_DISABLE === "1") {
    return noopRecorderHooks();
  }
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
  const optimize = resolved.optimize ?? process.env.AGENT_BLACKBOX_OPTIMIZE === "1";
  const factory = createOpenCodeEventFactory({
    runId,
    sink,
    defaultSessionId: "unknown-session",
    optimize,
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
    },
    // In-run actuator (opt-in). A compaction means the agent may have lost content,
    // so we reset the "still in context" generation; the system transform injects
    // the working-set memory. Both no-op when optimize is off.
    "experimental.session.compacting": async () => {
      factory.onCompaction();
    },
    "experimental.chat.system.transform": async (_input, output) => {
      factory.injectWorkingSet(output);
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
  optimize: boolean;
  homeDir?: string;
  projectDir?: string;
  cliPrompt?: string;
  rawStored: boolean;
}) {
  let seq = 0;
  // The CLI `run` prompt is the single top-level instruction — emit it once, on the
  // root session only. Without this guard a multi-agent run replays it into every
  // subagent session ("Prompt received" duplicated per lane).
  let cliPromptEmitted = false;
  const subagentSessions = new Map<string, { agent: string; parentId: string }>();

  // --- in-run optimizer state (only used when options.optimize) ---------------
  const readCache = new Map<string, ReadCacheEntry>(); // `${sessionId}::${path}` -> last served
  const wsFiles = new Map<string, WorkingSetFile>(); // path -> read/edit counts
  const wsCommands: string[] = [];
  let compactionGen = 0; // bumped on every compaction → invalidates "still in context"
  const bumpFile = (path: string, kind: "read" | "edit", hash?: string) => {
    const f = wsFiles.get(path) ?? { path, reads: 0, edits: 0 };
    if (kind === "read") f.reads += 1;
    else f.edits += 1;
    if (hash) f.hash = hash;
    wsFiles.set(path, f);
  };
  const optimizeReadAfter = (input: Record<string, unknown>, output: Record<string, unknown>): void => {
    const tool = input.tool;
    const path = readArgPath(input.args);
    if (isEditTool(tool) && path) bumpFile(path, "edit");
    if (isBashTool(tool)) {
      const command = readString(input.args, "command");
      const exit = readExitCode(output);
      if (command && isReusableCommand(command) && (exit === 0 || exit === undefined)) {
        if (!wsCommands.includes(command)) wsCommands.push(command);
      }
    }
    if (!isReadTool(tool) || !path) return;
    const current = typeof output.output === "string" ? output.output : "";
    if (!current) return;
    const key = `${readString(input, "sessionID") ?? "s"}::${path}`;
    const hash = hashContent(current);
    const decision = decideReadServe(readCache.get(key), { hash, content: current }, compactionGen, path);
    readCache.set(key, { hash, content: current, gen: compactionGen });
    bumpFile(path, "read", hash);
    if (decision.mode !== "full" && typeof decision.output === "string" && decision.saved > 0) {
      output.output = decision.output; // serve no-op/diff instead of full bytes
    }
  };
  const attributeToSubagent = (event: TraceEvent): TraceEvent => {
    const owner = subagentSessions.get(event.sessionId);
    if (!owner) return event;
    return {
      ...event,
      agentId: owner.agent,
      agentRole: "subagent",
      parentSessionId: event.parentSessionId ?? owner.parentId
    };
  };
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
      const subagent = subagentSessionFromEvent(rawEvent);
      if (subagent) {
        subagentSessions.set(subagent.sessionId, { agent: subagent.agent, parentId: subagent.parentId });
      }
      if (!shouldRecordOpenCodeEvent(rawEvent)) {
        return;
      }
      const event = attributeToSubagent(normalizeOpenCodeEvent(rawEvent, nextContext()));
      await options.sink.write(event);
      // Only the root session's first creation carries the CLI prompt — never a subagent's.
      if (options.cliPrompt && !cliPromptEmitted && !subagent && event.kind === "session_created") {
        cliPromptEmitted = true;
        await options.sink.write(normalizeSyntheticUserPrompt(options.cliPrompt, event, nextContext()));
      }
    },
    async writeToolBefore(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
      await options.sink.write(attributeToSubagent(normalizeToolBefore(input, output, nextContext())));
    },
    async writeToolAfter(input: Record<string, unknown>, output: Record<string, unknown>): Promise<void> {
      // Optimize BEFORE recording so the trace (and the efficiency score) reflect
      // the leaner output the model actually received.
      if (options.optimize) optimizeReadAfter(input, output);
      await options.sink.write(attributeToSubagent(normalizeToolAfter(input, output, nextContext())));
    },
    onCompaction(): void {
      if (options.optimize) compactionGen += 1;
    },
    injectWorkingSet(output: Record<string, unknown>): void {
      if (!options.optimize) return;
      const block = buildWorkingSetBlock([...wsFiles.values()], wsCommands);
      if (!block) return;
      const system = output.system;
      if (Array.isArray(system)) system.push(block); // append → keep the cacheable prefix stable
    }
  };
}

function isEditTool(tool: unknown): boolean {
  return typeof tool === "string" && ["edit", "write", "patch", "multiedit", "apply_patch"].includes(tool.toLowerCase());
}

function isBashTool(tool: unknown): boolean {
  return typeof tool === "string" && ["bash", "shell", "sh", "run", "command"].includes(tool.toLowerCase());
}

function readString(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readExitCode(output: Record<string, unknown>): number | undefined {
  const direct = output.exitCode ?? output.exit;
  if (typeof direct === "number") return direct;
  const meta = output.metadata;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    const v = m.exitCode ?? m.exit;
    if (typeof v === "number") return v;
  }
  return undefined;
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
