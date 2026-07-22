import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createClaudeNormalizer } from "./normalize.js";
import type { ClaudeNormalizerContext, ClaudeRecorderOptions, TraceSink } from "./types.js";

export function defaultProjectsDir(homeDir = homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? join(override, "projects") : join(homeDir, ".claude", "projects");
}

// Drain appended bytes in bounded chunks so a large backfilled transcript never
// allocates its whole delta (raw buffer + decoded string + split array) at once.
const DRAIN_CHUNK_BYTES = 1 << 20; // 1 MiB

type FileState = {
  offset: number;
  buffer: string;
  normalizer: ReturnType<typeof createClaudeNormalizer>;
  // Carries an incomplete trailing UTF-8 sequence across chunk/poll boundaries so a
  // multibyte char split by a chunk edge is never decoded to a replacement char.
  decoder: StringDecoder;
};

/**
 * Tail every Claude Code transcript under `projectsDir` and stream normalized
 * TraceEvents to `sink`. No install into Claude Code — it just reads the JSONL
 * the CLI already writes. Returns a `stop()` to clear the poll timer.
 *
 * By default it tails from the CURRENT END of each existing transcript, so it
 * records only activity from `up` onward. Set `backfillDays > 0` to also re-read
 * recent transcripts from the top — that's the heavy path (a busy ~/.claude can
 * hold hundreds of MB across every project), so it's opt-in.
 */
export async function startClaudeCodeTailer(sink: TraceSink, options: ClaudeRecorderOptions = {}): Promise<{ stop: () => void; projectsDir: string }> {
  const homeDir = options.homeDir ?? homedir();
  const projectsDir = options.projectsDir ?? defaultProjectsDir(homeDir);
  const pollMs = options.pollMs ?? 700;
  const backfillCutoff = Date.now() - (options.backfillDays ?? 0) * 24 * 60 * 60 * 1000;

  const files = new Map<string, FileState>();
  const seqByRun = new Map<string, number>();
  // Serialize drains per file so the background backfill and the live poll never
  // read/parse the same transcript concurrently (which would corrupt its offset).
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
    const n = (seqByRun.get(runId) ?? 0) + 1;
    seqByRun.set(runId, n);
    return n;
  };

  // `agent-<id>.jsonl` = a subagent transcript → fork a lane keyed by that id. The
  // parent run is taken per line from the inherited sessionId (see normalize), so
  // no spawn registry is needed. A main `<sessionId>.jsonl` runs as its own run.
  const contextForFile = (filePath: string): ClaudeNormalizerContext => {
    const base = basename(filePath).replace(/\.jsonl$/, "");
    const common: ClaudeNormalizerContext = {
      defaultSessionId: base,
      homeDir,
      ...(options.rawStored !== undefined ? { rawStored: options.rawStored } : {})
    };
    return base.startsWith("agent-") ? { ...common, agent: { agentId: base.slice("agent-".length) } } : common;
  };

  const ensureFile = (filePath: string): FileState => {
    let state = files.get(filePath);
    if (!state) {
      state = { offset: 0, buffer: "", normalizer: createClaudeNormalizer(contextForFile(filePath)), decoder: new StringDecoder("utf8") };
      files.set(filePath, state);
    }
    return state;
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

      const fh = await open(filePath, "r");
      try {
        const chunk = Buffer.alloc(DRAIN_CHUNK_BYTES);
        while (running && state.offset < size) {
          const toRead = Math.min(DRAIN_CHUNK_BYTES, size - state.offset);
          const { bytesRead } = await fh.read(chunk, 0, toRead, state.offset);
          if (bytesRead <= 0) break;
          state.offset += bytesRead;
          state.buffer += state.decoder.write(chunk.subarray(0, bytesRead));
          const lines = state.buffer.split(/\r?\n/); // CRLF-safe: a Windows transcript ends lines with \r\n
          state.buffer = lines.pop() ?? ""; // trailing partial line stays buffered (may span chunks)
          for (const raw of lines) {
            if (!running) return;
            const line = raw.trim();
            if (!line) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              continue; // skip a malformed line rather than stall the tailer
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
      entries = await readdir(projectsDir, { recursive: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(projectsDir, e));
  };

  // Tail from the CURRENT END by default: prime every existing transcript's offset to
  // its size so we stream only NEW activity from now on. Without this, startup (and
  // then the first poll) would re-ingest the entire backlog under ~/.claude/projects —
  // for a heavy user that's hundreds of MB across every project in one burst.
  const initial = await listTranscripts();
  const recent: string[] = [];
  for (const f of initial) {
    try {
      const info = await stat(f);
      ensureFile(f).offset = info.size;
      if ((options.backfillDays ?? 0) > 0 && info.mtimeMs >= backfillCutoff) recent.push(f);
    } catch {
      /* ignore */
    }
  }
  recent.sort((a, b) => Number(basename(a).startsWith("agent-")) - Number(basename(b).startsWith("agent-")));
  // Reserve every initial file selected for backfill before the live timer starts.
  // Otherwise a poll can consume a new append first and the later restart-from-zero
  // backfill will emit that same append a second time.
  const backfillPending = new Set(recent);

  // Opt-in backfill (backfillDays > 0) runs in the BACKGROUND so `up` returns and the
  // dashboard comes up immediately; historical runs then stream in as they're parsed
  // instead of blocking startup until the whole (possibly hundreds-of-MB) backlog
  // drains. Main files before agent files so subagent lines attribute to a known
  // parent, and the per-file lock keeps it from racing the live poll below.
  const backfill = async (): Promise<void> => {
    if ((options.backfillDays ?? 0) <= 0) return;
    for (const f of recent) {
      if (!running) return;
      try {
        await drainFile(f, true);
      } catch {
        /* best-effort */
      } finally {
        backfillPending.delete(f);
      }
    }
  };

  let running = true;
  let tickRunning = false;
  const tick = async (): Promise<void> => {
    if (!running || tickRunning) return;
    tickRunning = true;
    try {
      const all = await listTranscripts();
      all.sort((a, b) => Number(basename(a).startsWith("agent-")) - Number(basename(b).startsWith("agent-")));
      for (const f of all) {
        if (!running) return;
        if (backfillPending.has(f)) continue;
        try {
          await drainFile(f);
        } catch {
          /* best-effort: one bad file must not stop the tailer */
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
