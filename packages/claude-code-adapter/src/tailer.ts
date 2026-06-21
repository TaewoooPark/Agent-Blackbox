import { createTraceEvent, type TraceEventInput } from "@agent-blackbox/core";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createClaudeNormalizer } from "./normalize.js";
import type { ClaudeNormalizerContext, ClaudeRecorderOptions, TraceSink } from "./types.js";

export function defaultProjectsDir(homeDir = homedir()): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? join(override, "projects") : join(homeDir, ".claude", "projects");
}

type FileState = {
  offset: number;
  buffer: string;
  normalizer: ReturnType<typeof createClaudeNormalizer>;
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
      state = { offset: 0, buffer: "", normalizer: createClaudeNormalizer(contextForFile(filePath)) };
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
      const events = state.normalizer.consume(parsed as Record<string, unknown>);
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

  // Tail from the CURRENT END by default: prime every existing transcript's offset to
  // its size so we stream only NEW activity from now on. Without this, startup (and
  // then the first poll) would re-ingest the entire backlog under ~/.claude/projects —
  // for a heavy user that's hundreds of MB across every project in one burst.
  const initial = await listTranscripts();
  for (const f of initial) {
    try {
      ensureFile(f).offset = (await stat(f)).size;
    } catch {
      /* ignore */
    }
  }

  // Opt-in backfill (backfillDays > 0): re-read recent transcripts from the top so the
  // dashboard shows existing runs. Main files before agent files so subagent lines
  // attribute to a known parent.
  if ((options.backfillDays ?? 0) > 0) {
    const recent: string[] = [];
    for (const f of initial) {
      try {
        if ((await stat(f)).mtimeMs >= backfillCutoff) recent.push(f);
      } catch {
        /* ignore */
      }
    }
    recent.sort((a, b) => Number(basename(a).startsWith("agent-")) - Number(basename(b).startsWith("agent-")));
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
