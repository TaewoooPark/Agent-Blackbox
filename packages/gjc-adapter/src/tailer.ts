import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createGjcNormalizer } from "./normalize.js";
import type { GjcNormalizerContext, GjcRecorderOptions, TraceSink } from "./types.js";

export function defaultGjcSessionsDir(homeDir = homedir()): string {
  const override = process.env.GJC_CODING_AGENT_DIR;
  return override && override.length > 0 ? join(override, "sessions") : join(homeDir, ".gjc", "agent", "sessions");
}

type FileState = {
  offset: number;
  buffer: string;
  normalizer: ReturnType<typeof createGjcNormalizer>;
};

export async function startGjcTailer(sink: TraceSink, options: GjcRecorderOptions = {}): Promise<{ stop: () => void; sessionsDir: string }> {
  const homeDir = options.homeDir ?? homedir();
  const sessionsDir = options.sessionsDir ?? defaultGjcSessionsDir(homeDir);
  const pollMs = options.pollMs ?? 700;
  const backfillCutoff = Date.now() - (options.backfillDays ?? 0) * 24 * 60 * 60 * 1000;

  const files = new Map<string, FileState>();
  const seqByRun = new Map<string, number>();
  const nextSeq = (runId: string): number => {
    const n = (seqByRun.get(runId) ?? 0) + 1;
    seqByRun.set(runId, n);
    return n;
  };

  const contextForFile = (filePath: string): GjcNormalizerContext => {
    const base = basename(filePath).replace(/\.jsonl$/, "");
    const common: GjcNormalizerContext = {
      defaultSessionId: isSubagentFile(filePath) ? extractSessionIdFromPath(filePath) : extractSessionId(base),
      homeDir,
      ...(options.rawStored !== undefined ? { rawStored: options.rawStored } : {})
    };
    if (isSubagentFile(filePath)) {
      return { ...common, agent: { agentId: base } };
    }
    return common;
  };

  const ensureFile = (filePath: string): FileState => {
    let state = files.get(filePath);
    if (!state) {
      state = { offset: 0, buffer: "", normalizer: createGjcNormalizer(contextForFile(filePath)) };
      files.set(filePath, state);
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

    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const events = state.normalizer.consume(parsed as Record<string, unknown>);
      for (const input of events) await emit(sink, input, nextSeq);
    }
  };

  const listTranscripts = async (): Promise<string[]> => {
    let entries: string[];
    try {
      entries = await readdir(sessionsDir, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(sessionsDir, e));
  };

  const initial = await listTranscripts();
  for (const f of initial) {
    try {
      ensureFile(f).offset = (await stat(f)).size;
    } catch {
      /* ignore */
    }
  }

  if ((options.backfillDays ?? 0) > 0) {
    const recent: string[] = [];
    for (const f of initial) {
      try {
        if ((await stat(f)).mtimeMs >= backfillCutoff) recent.push(f);
      } catch {
        /* ignore */
      }
    }
    recent.sort((a, b) => Number(isSubagentFile(a)) - Number(isSubagentFile(b)));
    for (const f of recent) {
      const state = files.get(f);
      if (state) {
        state.offset = 0;
        state.buffer = "";
      }
      await drainFile(f);
    }
  }

  let running = true;
  const tick = async (): Promise<void> => {
    if (!running) return;
    const all = await listTranscripts();
    all.sort((a, b) => Number(isSubagentFile(a)) - Number(isSubagentFile(b)));
    for (const f of all) {
      try {
        await drainFile(f);
      } catch {
        /* best-effort */
      }
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    sessionsDir,
    stop: () => {
      running = false;
      clearInterval(timer);
    }
  };
}

function extractSessionId(base: string): string {
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? base;
}

function extractSessionIdFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/).reverse();
  for (const part of parts) {
    const base = part.replace(/\.jsonl$/, "");
    const id = extractSessionId(base);
    if (id !== base) return id;
  }
  return basename(filePath).replace(/\.jsonl$/, "");
}

function isSubagentFile(filePath: string): boolean {
  return !basename(filePath).includes("_");
}

async function emit(sink: TraceSink, input: TraceEventInput, nextSeq: (runId: string) => number): Promise<void> {
  const event = createTraceEvent(nextSeq(input.runId), input);
  await sink.write(event);
}
