import type { TraceEvent } from "./events.js";

// A compact, redacted causal timeline for the suggestion model. The metric digest
// says "redundant-reads: 2" but not WHY — a re-read right after a context
// compaction is legitimate (the window was reset), while a re-read with nothing
// between is genuine waste. This encodes that distinction explicitly: a read is
// tagged "reread" only when the same file was already read AND no compaction has
// happened since. The model can then avoid scolding the expected case.
//
// Redaction: basenames and command verbs only — never full paths, command lines,
// content, or prompts. Same discipline as the offender labels.

export type TimelineAct = "read" | "reread" | "edit" | "create" | "bash" | "search" | "compact" | "error" | "subagent";

export type TimelineEntry = {
  seq: number;
  act: TimelineAct;
  target?: string; // basename / command verb / agent name — already redacted
};

const SEARCH_VERBS = new Set(["grep", "rg", "ag", "ack", "find", "fd"]);

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const str = (e: TraceEvent, k: string): string | undefined =>
  typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined;

/**
 * Build the annotated timeline, newest activity last, capped to the most recent
 * `maxEntries` actionable events (messages/turns/heartbeats are skipped). Compaction
 * boundaries are preserved as their own entries so the model sees where the window
 * was reset.
 */
export function buildCausalTimeline(events: TraceEvent[], opts: { maxEntries?: number } = {}): TimelineEntry[] {
  const maxEntries = opts.maxEntries ?? 40;
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const readSinceCompaction = new Set<string>();
  const out: TimelineEntry[] = [];

  for (const e of ordered) {
    switch (e.kind) {
      case "file_read": {
        const path = str(e, "path");
        const target = path ? baseName(path) : undefined;
        const isReread = path !== undefined && readSinceCompaction.has(path);
        if (path) readSinceCompaction.add(path);
        out.push({ seq: e.seq, act: isReread ? "reread" : "read", ...(target ? { target } : {}) });
        break;
      }
      case "file_edit": {
        const path = str(e, "path");
        out.push({ seq: e.seq, act: "edit", ...(path ? { target: baseName(path) } : {}) });
        break;
      }
      case "file_created": {
        const path = str(e, "path");
        out.push({ seq: e.seq, act: "create", ...(path ? { target: baseName(path) } : {}) });
        break;
      }
      case "bash": {
        const command = (str(e, "command") ?? "").trim();
        const verb = command.split(/\s+/)[0] ?? "";
        out.push({ seq: e.seq, act: SEARCH_VERBS.has(verb) ? "search" : "bash", ...(verb ? { target: verb } : {}) });
        break;
      }
      case "context_compacted": {
        readSinceCompaction.clear(); // the window was reset — later re-reads are expected
        out.push({ seq: e.seq, act: "compact" });
        break;
      }
      case "session_error": {
        out.push({ seq: e.seq, act: "error" });
        break;
      }
      case "host_event": {
        if (str(e, "level") === "error") out.push({ seq: e.seq, act: "error" });
        break;
      }
      case "subagent_spawned": {
        const agent = str(e, "agent");
        out.push({ seq: e.seq, act: "subagent", ...(agent ? { target: agent } : {}) });
        break;
      }
      default:
        break;
    }
  }

  return out.length > maxEntries ? out.slice(out.length - maxEntries) : out;
}
