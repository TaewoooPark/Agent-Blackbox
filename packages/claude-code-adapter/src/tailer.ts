import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createClaudeNormalizer } from "./normalize.js";
import type { ClaudeNormalizerContext, ClaudeRecorderOptions, SubagentSpawn, TraceSink } from "./types.js";

export function defaultProjectsDir(homeDir = homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? join(override, "projects") : join(homeDir, ".claude", "projects");
}

type FileState = {
  offset: number;
  buffer: string;
  ctx: ClaudeNormalizerContext;
  normalizer: ReturnType<typeof createClaudeNormalizer>;
};

/**
 * Tail every Claude Code transcript under `projectsDir` and stream normalized
 * TraceEvents to `sink`. No install into Claude Code — it just reads the JSONL
 * the CLI already writes. Returns a `stop()` to clear the poll timer.
 */
export async function startClaudeCodeTailer(sink: TraceSink, options: ClaudeRecorderOptions = {}): Promise<{ stop: () => void; projectsDir: string }> {
  const homeDir = options.homeDir ?? homedir();
  const projectsDir = options.projectsDir ?? defaultProjectsDir(homeDir);
  const pollMs = options.pollMs ?? 700;
  const backfillCutoff = Date.now() - (options.backfillDays ?? 2) * 24 * 60 * 60 * 1000;

  const files = new Map<string, FileState>();
  const seqByRun = new Map<string, number>();
  const byAgentId = new Map<string, SubagentSpawn>();
  const nextSeq = (runId: string): number => {
    const n = (seqByRun.get(runId) ?? 0) + 1;
    seqByRun.set(runId, n);
    return n;
  };

  // Resolve a file's run/lane context. `agent-<id>.jsonl` = a subagent transcript;
  // link it to the parent run via the spawn registry (filled from Task/Agent
  // results). A main `<sessionId>.jsonl` runs as its own run.
  const contextForFile = (filePath: string): ClaudeNormalizerContext => {
    const base = basename(filePath).replace(/\.jsonl$/, "");
    if (base.startsWith("agent-")) {
      const agentId = base.slice("agent-".length);
      const spawn = byAgentId.get(agentId);
      const parentSessionId = spawn?.parentSessionId ?? agentId;
      return {
        runId: spawn?.parentRunId ?? agentId,
        defaultSessionId: agentId,
        homeDir,
        ...(options.rawStored !== undefined ? { rawStored: options.rawStored } : {}),
        agent: { agentId, parentSessionId, ...(spawn?.label ? { label: spawn.label } : {}) }
      };
    }
    return {
      runId: base,
      defaultSessionId: base,
      homeDir,
      ...(options.rawStored !== undefined ? { rawStored: options.rawStored } : {})
    };
  };

  const ensureFile = (filePath: string): FileState => {
    let state = files.get(filePath);
    if (!state) {
      const ctx = contextForFile(filePath);
      state = { offset: 0, buffer: "", ctx, normalizer: createClaudeNormalizer(ctx) };
      files.set(filePath, state);
    } else if (state.ctx.agent && state.ctx.runId === state.ctx.defaultSessionId) {
      // Parent linkage may have arrived after this subagent file was first seen —
      // refresh runId/parent so later lines attach under the parent run.
      const spawn = byAgentId.get(state.ctx.agent.agentId);
      if (spawn) {
        state.ctx.runId = spawn.parentRunId;
        state.ctx.agent.parentSessionId = spawn.parentSessionId;
      }
    }
    return state;
  };

  const drainFile = async (filePath: string): Promise<void> => {
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return;
    }
    const state = ensureFile(filePath);
    if (size < state.offset) {
      // Truncated/rotated — restart from the top.
      state.offset = 0;
      state.buffer = "";
    }
    if (size <= state.offset) return;

    const fh = await open(filePath, "r");
    try {
      const length = size - state.offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, state.offset);
      state.offset = size;
      state.buffer += buf.toString("utf8");
    } finally {
      await fh.close();
    }

    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? ""; // trailing partial line stays buffered
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // skip a malformed line rather than stall the tailer
      }
      const { events, spawns } = state.normalizer.consume(parsed as Record<string, unknown>);
      for (const spawn of spawns) byAgentId.set(spawn.agentId, spawn);
      for (const input of events) await emit(sink, input, nextSeq);
    }
  };

  const listTranscripts = async (): Promise<string[]> => {
    let entries: string[];
    try {
      entries = await readdir(projectsDir, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(projectsDir, e));
  };

  // Backfill: seed recent transcripts (main files before agent files so the spawn
  // registry is populated before subagent lines are attributed).
  const initial = await listTranscripts();
  const recent: string[] = [];
  for (const f of initial) {
    try {
      if ((await stat(f)).mtimeMs >= backfillCutoff) recent.push(f);
    } catch {
      /* ignore */
    }
  }
  recent.sort((a, b) => Number(basename(a).startsWith("agent-")) - Number(basename(b).startsWith("agent-")));
  for (const f of recent) await drainFile(f);

  let running = true;
  const tick = async (): Promise<void> => {
    if (!running) return;
    const all = await listTranscripts();
    all.sort((a, b) => Number(basename(a).startsWith("agent-")) - Number(basename(b).startsWith("agent-")));
    for (const f of all) {
      try {
        await drainFile(f);
      } catch {
        /* best-effort: one bad file must not stop the tailer */
      }
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    projectsDir,
    stop: () => {
      running = false;
      clearInterval(timer);
    }
  };
}

async function emit(sink: TraceSink, input: TraceEventInput, nextSeq: (runId: string) => number): Promise<void> {
  const event = createTraceEvent(nextSeq(input.runId), input);
  await sink.write(event);
}
