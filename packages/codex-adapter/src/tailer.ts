import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createCodexNormalizer } from "./normalize.js";
import type { CodexNormalizerContext, CodexRecorderOptions, TraceSink } from "./types.js";

export function defaultCodexSessionsDir(homeDir = homedir()): string {
  const override = process.env.CODEX_HOME;
  return override && override.length > 0 ? join(override, "sessions") : join(homeDir, ".codex", "sessions");
}

type FileState = {
  offset: number;
  buffer: string;
  normalizer: ReturnType<typeof createCodexNormalizer>;
};

/** Tail active Codex rollout JSONL files without installing anything into Codex. */
export async function startCodexTailer(
  sink: TraceSink,
  options: CodexRecorderOptions = {}
): Promise<{ stop: () => void; sessionsDir: string }> {
  const homeDir = options.homeDir ?? homedir();
  const sessionsDir = options.sessionsDir ?? defaultCodexSessionsDir(homeDir);
  const pollMs = options.pollMs ?? 700;
  const backfillCutoff = Date.now() - (options.backfillDays ?? 0) * 24 * 60 * 60 * 1000;
  const files = new Map<string, FileState>();
  const seqByRun = new Map<string, number>();

  const nextSeq = (runId: string): number => {
    const next = (seqByRun.get(runId) ?? 0) + 1;
    seqByRun.set(runId, next);
    return next;
  };

  const contextForFile = (filePath: string): CodexNormalizerContext => ({
    defaultSessionId: extractSessionId(basename(filePath, ".jsonl")),
    homeDir,
    ...(options.rawStored !== undefined ? { rawStored: options.rawStored } : {})
  });

  const ensureFile = (filePath: string): FileState => {
    let state = files.get(filePath);
    if (!state) {
      state = { offset: 0, buffer: "", normalizer: createCodexNormalizer(contextForFile(filePath)) };
      files.set(filePath, state);
    }
    return state;
  };

  // Existing subagent rollouts use the root thread id only in their first metadata
  // line. Prime that line even when tailing from EOF so later appends stay grouped
  // under the parent run and keep their subagent lane.
  const primeFile = async (filePath: string): Promise<void> => {
    const first = await readFirstLine(filePath);
    if (!first) return;
    try {
      ensureFile(filePath).normalizer.prime(JSON.parse(first) as Record<string, unknown>);
    } catch {
      /* malformed metadata is non-fatal; filename id remains the fallback */
    }
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

    const file = await open(filePath, "r");
    try {
      const length = size - state.offset;
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, state.offset);
      state.offset = size;
      state.buffer += buffer.toString("utf8");
    } finally {
      await file.close();
    }

    const lines = state.buffer.split(/\r?\n/);
    state.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const input of state.normalizer.consume(parsed as Record<string, unknown>)) {
        await emit(sink, input, nextSeq);
      }
    }
  };

  const listTranscripts = async (): Promise<string[]> => {
    let entries: string[];
    try {
      entries = await readdir(sessionsDir, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(sessionsDir, entry)).sort();
  };

  const initial = await listTranscripts();
  for (const filePath of initial) {
    try {
      await primeFile(filePath);
      ensureFile(filePath).offset = (await stat(filePath)).size;
    } catch {
      /* file may rotate while starting */
    }
  }

  if ((options.backfillDays ?? 0) > 0) {
    for (const filePath of initial) {
      try {
        if ((await stat(filePath)).mtimeMs < backfillCutoff) continue;
        const state = ensureFile(filePath);
        state.offset = 0;
        state.buffer = "";
        await drainFile(filePath);
      } catch {
        /* best-effort backfill */
      }
    }
  }

  let running = true;
  const tick = async (): Promise<void> => {
    if (!running) return;
    for (const filePath of await listTranscripts()) {
      try {
        await drainFile(filePath);
      } catch {
        /* one malformed/rotating rollout must not stop the recorder */
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

async function readFirstLine(filePath: string, maxBytes = 2 * 1024 * 1024): Promise<string | undefined> {
  const file = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      const actual = chunk.subarray(0, bytesRead);
      const newline = actual.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(actual.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8").trim() || undefined;
      }
      chunks.push(actual);
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString("utf8").trim() || undefined;
  } finally {
    await file.close();
  }
}

async function emit(sink: TraceSink, input: TraceEventInput, nextSeq: (runId: string) => number): Promise<void> {
  await sink.write(createTraceEvent(nextSeq(input.runId), input));
}
