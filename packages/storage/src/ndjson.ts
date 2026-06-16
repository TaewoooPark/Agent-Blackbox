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
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => parseTraceEventLine(line));
}

export async function appendTraceEvent(filePath: string, event: TraceEvent): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, serializeTraceEvent(event), "utf8");
}

export async function readTraceEvents(filePath: string): Promise<TraceEvent[]> {
  const input = await readFile(filePath, "utf8");
  return parseTraceEvents(input);
}

