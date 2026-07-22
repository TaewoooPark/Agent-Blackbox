import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createCodexNormalizer } from "./normalize.js";
import type { CodexNormalizerContext, CodexRecorderOptions, TraceSink } from "./types.js";

export function defaultCodexSessionsDir(homeDir = homedir()): string {
  const override = process.env.CODEX_HOME;
  return override && override.length > 0 ? join(override, "sessions") : join(homeDir, ".codex", "sessions");
}

// Drain appended bytes in bounded chunks so a large backfilled rollout never
// allocates its whole delta (raw buffer + decoded string + split array) at once.
const DRAIN_CHUNK_BYTES = 1 << 20; // 1 MiB

type FileState = {
  offset: number;
  buffer: string;
  normalizer: ReturnType<typeof createCodexNormalizer>;
  // Carries an incomplete trailing UTF-8 sequence across chunk/poll boundaries so a
  // multibyte char split by a chunk edge is never decoded to a replacement char.
  decoder: StringDecoder;
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
  // Serialize drains per file so the background backfill and the live poll never
  // read/parse the same rollout concurrently (which would corrupt its offset).
  const drainLocks = new Map<string, Promise<unknown>>();
  const withFileLock = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const prev = drainLocks.get(key) ?? Promise.resolve();
    const next = prev.then(run, run);
    const tail = next.then(() => undefined, () => undefined);
    drainLocks.set(key, tail);
    try {
      return await next;
    } finally {
      if (drainLocks.get(key) === tail) drainLocks.delete(key);
    }
  };

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
      state = { offset: 0, buffer: "", normalizer: createCodexNormalizer(contextForFile(filePath)), decoder: new StringDecoder("utf8") };
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

  const drainFile = (filePath: string, restart = false): Promise<void> =>
    withFileLock(filePath, async () => {
      if (!running) return;
      let size: number;
      try {
        size = (await stat(filePath)).size;
      } catch {
        return;
      }
      const state = ensureFile(filePath);
      if (restart || size < state.offset) {
        // Backfill (restart) or a truncated/rotated file — re-read from the top.
        state.offset = 0;
        state.buffer = "";
        state.decoder = new StringDecoder("utf8");
      }
      if (size <= state.offset) return;

      const file = await open(filePath, "r");
      try {
        const chunk = Buffer.alloc(DRAIN_CHUNK_BYTES);
        while (running && state.offset < size) {
          const toRead = Math.min(DRAIN_CHUNK_BYTES, size - state.offset);
          const { bytesRead } = await file.read(chunk, 0, toRead, state.offset);
          if (bytesRead <= 0) break;
          state.offset += bytesRead;
          state.buffer += state.decoder.write(chunk.subarray(0, bytesRead));
          const lines = state.buffer.split(/\r?\n/);
          state.buffer = lines.pop() ?? ""; // trailing partial line stays buffered (may span chunks)
          for (const raw of lines) {
            if (!running) return;
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
        }
      } finally {
        await file.close();
      }
    });

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
  const recent: string[] = [];
  for (const filePath of initial) {
    try {
      await primeFile(filePath);
      const info = await stat(filePath);
      ensureFile(filePath).offset = info.size;
      if ((options.backfillDays ?? 0) > 0 && info.mtimeMs >= backfillCutoff) recent.push(filePath);
    } catch {
      /* file may rotate while starting */
    }
  }
  // Reserve every initial file selected for backfill before the live timer starts.
  // Otherwise a poll can consume a new append first and the later restart-from-zero
  // backfill will emit that same append a second time.
  const backfillPending = new Set(recent);

  // Opt-in backfill (backfillDays > 0) runs in the BACKGROUND so `up` returns and the
  // dashboard comes up immediately; historical runs then stream in as they're parsed
  // instead of blocking startup until the whole backlog drains. The per-file lock
  // keeps it from racing the live poll below.
  const backfill = async (): Promise<void> => {
    if ((options.backfillDays ?? 0) <= 0) return;
    for (const filePath of recent) {
      if (!running) return;
      try {
        await drainFile(filePath, true);
      } catch {
        /* best-effort backfill */
      } finally {
        backfillPending.delete(filePath);
      }
    }
  };

  let running = true;
  let tickRunning = false;
  const tick = async (): Promise<void> => {
    if (!running || tickRunning) return;
    tickRunning = true;
    try {
      for (const filePath of await listTranscripts()) {
        if (!running) return;
        if (backfillPending.has(filePath)) continue;
        try {
          await drainFile(filePath);
        } catch {
          /* one malformed/rotating rollout must not stop the recorder */
        }
      }
    } finally {
      tickRunning = false;
    }
  };
  const timer = setInterval(() => void tick(), pollMs);
  if (typeof timer.unref === "function") timer.unref();

  // Not awaited: the tailer returns now and history fills in behind the live stream.
  void backfill();

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
