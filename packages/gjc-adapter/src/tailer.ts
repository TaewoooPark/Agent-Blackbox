import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createGjcNormalizer } from "./normalize.js";
import type { GjcNormalizerContext, GjcRecorderOptions, TraceSink } from "./types.js";

// Drain appended bytes in bounded chunks so a large backfilled transcript never
// allocates its whole delta (raw buffer + decoded string + split array) at once.
const DRAIN_CHUNK_BYTES = 1 << 20; // 1 MiB

export function defaultGjcSessionsDir(homeDir = homedir()): string {
  const override = process.env.GJC_CODING_AGENT_DIR;
  return override && override.length > 0 ? join(override, "sessions") : join(homeDir, ".gjc", "agent", "sessions");
}

type FileState = {
  offset: number;
  buffer: string;
  normalizer: ReturnType<typeof createGjcNormalizer>;
  // Carries an incomplete trailing UTF-8 sequence across chunk/poll boundaries so a
  // multibyte char split by a chunk edge is never decoded to a replacement char.
  decoder: StringDecoder;
};

export async function startGjcTailer(sink: TraceSink, options: GjcRecorderOptions = {}): Promise<{ stop: () => void; sessionsDir: string }> {
  const homeDir = options.homeDir ?? homedir();
  const sessionsDir = options.sessionsDir ?? defaultGjcSessionsDir(homeDir);
  const pollMs = options.pollMs ?? 700;
  const backfillCutoff = Date.now() - (options.backfillDays ?? 0) * 24 * 60 * 60 * 1000;

  const files = new Map<string, FileState>();
  const seqByRun = new Map<string, number>();
  // Serialize drains per file so the background backfill and the live poll never
  // read/parse the same transcript concurrently (which would corrupt its offset).
  const drainLocks = new Map<string, Promise<unknown>>();
  const withFileLock = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const prev = drainLocks.get(key) ?? Promise.resolve();
    const next = prev.then(run, run);
    drainLocks.set(key, next.then(() => undefined, () => undefined));
    return next;
  };
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
      state = { offset: 0, buffer: "", normalizer: createGjcNormalizer(contextForFile(filePath)), decoder: new StringDecoder("utf8") };
      files.set(filePath, state);
    }
    return state;
  };

  const drainFile = (filePath: string, restart = false): Promise<void> =>
    withFileLock(filePath, async () => {
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

      const fh = await open(filePath, "r");
      try {
        const chunk = Buffer.alloc(DRAIN_CHUNK_BYTES);
        while (state.offset < size) {
          const toRead = Math.min(DRAIN_CHUNK_BYTES, size - state.offset);
          const { bytesRead } = await fh.read(chunk, 0, toRead, state.offset);
          if (bytesRead <= 0) break;
          state.offset += bytesRead;
          state.buffer += state.decoder.write(chunk.subarray(0, bytesRead));
          const lines = state.buffer.split(/\r?\n/);
          state.buffer = lines.pop() ?? ""; // trailing partial line stays buffered (may span chunks)
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
        }
      } finally {
        await fh.close();
      }
    });

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

  // Opt-in backfill (backfillDays > 0) runs in the BACKGROUND so `up` returns and the
  // dashboard comes up immediately; historical runs then stream in as they're parsed
  // instead of blocking startup until the whole (possibly multi-GB) backlog drains.
  // The per-file lock keeps it from racing the live poll below.
  const backfill = async (): Promise<void> => {
    if ((options.backfillDays ?? 0) <= 0) return;
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
      if (!running) return;
      try {
        await drainFile(f, true);
      } catch {
        /* best-effort */
      }
    }
  };

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
  // Main sessions are "<timestamp>_<uuid>.jsonl" (basename ends in a session UUID); a
  // subagent transcript ("0-Worker.jsonl", "1-code_reviewer.jsonl") has no trailing
  // UUID. Key off that — NOT the presence of "_", which an underscored agent/skill name
  // would trip, misfiling the subagent as a main run.
  const base = basename(filePath).replace(/\.jsonl$/, "");
  return extractSessionId(base) === base;
}

async function emit(sink: TraceSink, input: TraceEventInput, nextSeq: (runId: string) => number): Promise<void> {
  const event = createTraceEvent(nextSeq(input.runId), input);
  await sink.write(event);
}
