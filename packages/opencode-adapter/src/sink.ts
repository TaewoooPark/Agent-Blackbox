import { appendTraceEvent } from "@agent-blackbox/storage";
import { join } from "node:path";
import type { OpenCodeRecorderOptions, TraceSink } from "./types.js";

export function createTraceSink(options: {
  directory: string;
  daemonUrl?: string;
  eventsFile?: string;
  sink?: TraceSink;
}): TraceSink {
  if (options.sink) {
    return options.sink;
  }
  if (options.daemonUrl) {
    return createHttpTraceSink(options.daemonUrl);
  }
  return createFileTraceSink(options.eventsFile ?? join(options.directory, ".agent-blackbox", "events.ndjson"));
}

export function createFileTraceSink(eventsFile: string): TraceSink {
  return {
    async write(event) {
      await appendTraceEvent(eventsFile, event);
    }
  };
}

export function createHttpTraceSink(daemonUrl: string): TraceSink {
  const endpoint = new URL("/events", daemonUrl.endsWith("/") ? daemonUrl : `${daemonUrl}/`);
  return {
    async write(event) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
      if (!response.ok) {
        throw new Error(`Agent-Blackbox daemon rejected event ${event.id}: HTTP ${response.status}`);
      }
    }
  };
}

export function resolveRecorderOptions(options: OpenCodeRecorderOptions): OpenCodeRecorderOptions {
  const resolved: OpenCodeRecorderOptions = {};
  const daemonUrl = options.daemonUrl ?? process.env.AGENT_BLACKBOX_DAEMON_URL;
  const runId = options.runId ?? process.env.AGENT_BLACKBOX_RUN_ID;
  if (daemonUrl) resolved.daemonUrl = daemonUrl;
  if (runId) resolved.runId = runId;
  if (options.eventsFile) resolved.eventsFile = options.eventsFile;
  if (options.sink) resolved.sink = options.sink;
  if (options.homeDir) resolved.homeDir = options.homeDir;
  if (options.projectDir) resolved.projectDir = options.projectDir;
  if (typeof options.rawStored === "boolean") resolved.rawStored = options.rawStored;
  return resolved;
}
