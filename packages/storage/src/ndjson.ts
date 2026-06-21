import { assertTraceEvent, type TraceEvent } from "@agent-blackbox/core";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export function serializeTraceEvent(event: TraceEvent): string {
  assertTraceEvent(event);
  return `${JSON.stringify(event)}\n`;
}

export function parseTraceEventLine(line: string): TraceEvent {
  const parsed: unknown = JSON.parse(line);
  assertTraceEvent(parsed);
  return parsed;
}

export function parseTraceEvents(input: string): TraceEvent[] {
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // The log is append-only and read concurrently, so the last record may be a
  // not-yet-flushed partial line. Only when the input is NOT newline-terminated
  // can the final segment be torn; tolerate a JSON syntax error there alone and
  // still surface any interior corruption (and any error on a complete last line).
  const lastIsPossiblyTorn = lines.length > 0 && !/\r?\n$/.test(input);
  const completeCount = lastIsPossiblyTorn ? lines.length - 1 : lines.length;
  const events = lines.slice(0, completeCount).map((line) => parseTraceEventLine(line));
  if (lastIsPossiblyTorn) {
    const lastLine = lines[lines.length - 1] as string;
    try {
      events.push(parseTraceEventLine(lastLine));
    } catch (error) {
      // A partially written final record (JSON.parse fails) is expected mid-append;
      // skip it. Any other error (e.g. a parsed-but-invalid event) still throws.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return events;
}

// Serialize appends per file. In global-recorder mode the daemon fields many
// simultaneous POST /events, and a large event line spans several write()
// syscalls — concurrent appends could interleave their chunks at EOF, producing
// a torn *interior* line that corrupts the log (the reader only tolerates a torn
// final line). A per-path promise chain keeps appends strictly ordered.
const writeChains = new Map<string, Promise<void>>();

export async function appendTraceEvent(filePath: string, event: TraceEvent): Promise<void> {
  // Serialize up front so a malformed event rejects the caller without poisoning
  // the shared chain.
  const line = serializeTraceEvent(event);
  const run = async (): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
  };
  // Run after any in-flight write to the same file, regardless of its outcome, so
  // one failure can't cancel later writes or reorder them.
  const prev = writeChains.get(filePath) ?? Promise.resolve();
  const next = prev.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  writeChains.set(filePath, tail);
  try {
    await next;
  } finally {
    if (writeChains.get(filePath) === tail) writeChains.delete(filePath);
  }
}

export async function readTraceEvents(filePath: string): Promise<TraceEvent[]> {
  const input = await readFile(filePath, "utf8");
  return parseTraceEvents(input);
}

