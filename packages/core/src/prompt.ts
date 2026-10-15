import type { TraceEvent } from "./events.js";
import { orderEventsForAnalysis } from "./analysisOrder.js";

// What the user actually asked for. Every surface that needs to name a run — the run
// picker, a node label, the handoff's objective — wants this same string, so it lives
// in one place: a second copy is how the hosts' payload shapes drift apart unnoticed.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function payloadPath(event: TraceEvent, path: string): unknown {
  let current: unknown = event.payload;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function stringAtPaths(event: TraceEvent, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = payloadPath(event, path);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function cleanPromptText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > 1600 ? `${normalized.slice(0, 1597)}...` : normalized;
}

function isDefaultSessionTitle(value: string): boolean {
  return /^new session\b/i.test(value.trim());
}

export function promptTextForEvent(event: TraceEvent): string | undefined {
  // OpenCode nests under properties.*; Claude Code puts role/text at the payload top
  // level. Read both so a prompt resolves regardless of host.
  const role =
    stringAtPaths(event, ["properties.role"]) ??
    stringAtPaths(event, ["properties.info.role"]) ??
    stringAtPaths(event, ["role"]);
  const text = stringAtPaths(event, [
    "properties.text",
    "properties.content",
    "properties.prompt",
    "properties.part.text",
    "properties.part.content",
    "text"
  ]);
  if (event.kind === "message" && role === "user" && text) {
    return cleanPromptText(text);
  }

  const title = stringAtPaths(event, ["properties.info.title"]);
  if ((event.kind === "session_created" || event.kind === "session_updated") && title && !isDefaultSessionTitle(title)) {
    return cleanPromptText(title);
  }
  return undefined;
}

/**
 * The run's objective: the first thing the user asked, trimmed to a line. Falls back
 * to a session title when the transcript opens without a user turn, and to undefined
 * when neither exists — a caller that has nothing to show should say so rather than
 * print an id and call it an objective.
 */
export function firstUserPrompt(events: TraceEvent[], maxChars = 240): string | undefined {
  for (const event of orderEventsForAnalysis(events)) {
    const prompt = promptTextForEvent(event);
    if (!prompt) continue;
    return prompt.length > maxChars ? `${prompt.slice(0, maxChars - 1)}…` : prompt;
  }
  return undefined;
}
