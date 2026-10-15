export const AGENT_BLACKBOX_STORAGE_VERSION = "0.1.0";

export function describeStorage(): string {
  return "Agent-Blackbox storage: append-only traces and replay indexes.";
}

export {
  appendTraceEvent,
  iterateTraceEvents,
  parseTraceEventLine,
  parseTraceEvents,
  readTraceEvents,
  serializeTraceEvent
} from "./ndjson.js";
