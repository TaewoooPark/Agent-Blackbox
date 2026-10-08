import { createTraceEvent } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createMotifcodeNormalizer } from "./normalize.js";
import type { MotifcodeNormalizerContext, MotifcodeRecorderOptions, TraceSink } from "./types.js";

/** Motifcode keeps its journals in the project, rather than a global user store. */
export function defaultMotifcodeSessionsDir(projectDir = process.cwd()): string {
  return resolve(projectDir, ".motif", "sessions");
}

const DRAIN_CHUNK_BYTES = 1 << 20;

type FileState = {
  offset: number;
  buffer: string;
  decoder: StringDecoder;
  identity?: string;
  normalizer: ReturnType<typeof createMotifcodeNormalizer>;
};

type InitialRead = { size: number; prime: boolean };

/** Tail Motifcode v2 journals, including journals created after the recorder starts. */
export async function startMotifcodeTailer(
  sink: TraceSink,
  options: MotifcodeRecorderOptions = {}
): Promise<{ stop: () => void; sessionsDir: string }> {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  const sessionsDir = options.sessionsDir ?? defaultMotifcodeSessionsDir(projectDir);
  const homeDir = options.homeDir ?? homedir();
  const backfillDays = options.backfillDays ?? 0;
  const backfillCutoff = Date.now() - backfillDays * 24 * 60 * 60 * 1000;
  const files = new Map<string, FileState>();
  const seqByRun = new Map<string, number>();
  const drainLocks = new Map<string, Promise<void>>();
  let running = true;

  const ensureFile = (filePath: string): FileState => {
    let state = files.get(filePath);
    if (!state) {
      const context: MotifcodeNormalizerContext = {
        defaultSessionId: basename(filePath, ".jsonl"),
        homeDir,
        projectDir,
        ...(options.rawStored !== undefined ? { rawStored: options.rawStored } : {})
      };
      state = {
        offset: 0,
        buffer: "",
        decoder: new StringDecoder("utf8"),
        normalizer: createMotifcodeNormalizer(context)
      };
      files.set(filePath, state);
    }
    return state;
  };

  const withFileLock = async (filePath: string, drain: () => Promise<void>): Promise<void> => {
    const previous = drainLocks.get(filePath) ?? Promise.resolve();
    const next = previous.then(drain, drain);
    const settled = next.then(() => undefined, () => undefined);
    drainLocks.set(filePath, settled);
    try {
      await next;
    } finally {
      if (drainLocks.get(filePath) === settled) drainLocks.delete(filePath);
    }
  };

  const drainFile = (filePath: string, initial?: InitialRead): Promise<void> =>
    withFileLock(filePath, async () => {
      if (!running) return;
      const file = await open(filePath, "r");
      try {
        const info = await file.stat();
        if (!info.isFile()) return;
        const state = ensureFile(filePath);
        const identity = `${info.dev}:${info.ino}`;
        const reset = (state.identity !== undefined && state.identity !== identity)
          || info.size < state.offset
          || (initial !== undefined && info.size < initial.size);
        if (reset) {
          state.offset = 0;
          state.buffer = "";
          state.decoder = new StringDecoder("utf8");
          // Keep the normalizer's journal sequence deduplication when a writer
          // replaces or rewrites the same journal. A new run header resets it.
        }
        state.identity = identity;
        const size = initial && !reset ? Math.min(initial.size, info.size) : info.size;
        const prime = initial?.prime === true && !reset;
        const chunk = Buffer.alloc(DRAIN_CHUNK_BYTES);
        while (running && state.offset < size) {
          const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - state.offset), state.offset);
          if (bytesRead === 0) break;
          state.offset += bytesRead;
          state.buffer += state.decoder.write(chunk.subarray(0, bytesRead));
          const lines = state.buffer.split(/\r?\n/);
          state.buffer = lines.pop() ?? "";
          for (const raw of lines) {
            if (!running) return;
            if (!raw.trim()) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              continue;
            }
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
            const line = parsed as Record<string, unknown>;
            if (prime) {
              state.normalizer.prime(line);
              continue;
            }
            for (const input of state.normalizer.consume(line)) {
              if (!running) return;
              const seq = (seqByRun.get(input.runId) ?? 0) + 1;
              seqByRun.set(input.runId, seq);
              await sink.write(createTraceEvent(seq, input));
            }
          }
        }
      } finally {
        await file.close();
      }
    });

  const listJournals = async (): Promise<string[]> => {
    try {
      const entries = await readdir(sessionsDir, { recursive: true });
      return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(sessionsDir, entry)).sort();
    } catch {
      // Motifcode may not have run in this project yet. A later poll discovers it.
      return [];
    }
  };

  const initial = new Map<string, InitialRead>();
  for (const filePath of await listJournals()) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) continue;
      ensureFile(filePath).identity = `${info.dev}:${info.ino}`;
      initial.set(filePath, {
        size: info.size,
        prime: !(backfillDays > 0 && info.mtimeMs >= backfillCutoff)
      });
    } catch {
      /* journals can rotate during discovery */
    }
  }

  // Scope metadata and pending tools can occur anywhere in a journal, so prime
  // all complete old records when starting at EOF. Read only the startup size:
  // appends during priming still become live events. Preserve an incomplete last
  // record (including a split UTF-8 code point) until a later append completes it.
  const initialize = async (): Promise<void> => {
    for (const [filePath, read] of initial) {
      if (!running) return;
      try {
        await drainFile(filePath, read);
      } catch {
        /* an unreadable journal must not prevent other journals from recording */
      } finally {
        initial.delete(filePath);
      }
    }
  };

  let tickRunning = false;
  const tick = async (): Promise<void> => {
    if (!running || tickRunning) return;
    tickRunning = true;
    try {
      for (const filePath of await listJournals()) {
        if (!running) return;
        // Reserve startup files so live polling cannot race priming/backfill.
        if (initial.has(filePath)) continue;
        try {
          await drainFile(filePath);
        } catch {
          /* a malformed or rotating journal must not stop the recorder */
        }
      }
    } finally {
      tickRunning = false;
    }
  };
  const timer = setInterval(() => void tick(), options.pollMs ?? 700);
  if (typeof timer.unref === "function") timer.unref();
  // Both priming and opt-in history run in the background, keeping `host all`
  // startup independent of the size of a project's existing Motifcode journals.
  void initialize();

  return {
    sessionsDir,
    stop: () => {
      running = false;
      clearInterval(timer);
    }
  };
}
