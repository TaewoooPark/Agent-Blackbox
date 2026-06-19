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

export type HttpTraceSinkOptions = {
  retries?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  onWarn?: (message: string) => void;
};

// Recording is best-effort observability: a daemon hiccup (e.g. ECONNRESET, a
// brief restart, or a 5xx) must never throw into the agent's hook and disrupt
// the run. Transient failures are retried with backoff; on persistent failure
// the event is dropped with a single warning instead of crashing the agent.
export function createHttpTraceSink(daemonUrl: string, options: HttpTraceSinkOptions = {}): TraceSink {
  const endpoint = new URL("/events", daemonUrl.endsWith("/") ? daemonUrl : `${daemonUrl}/`);
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 4000;
  const retryDelayMs = options.retryDelayMs ?? 120;
  const warn = options.onWarn ?? ((message: string) => console.warn(`[agent-blackbox] ${message}`));

  return {
    async write(event) {
      let lastError = "";
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(timeoutMs)
          });
          if (response.ok) {
            return;
          }
          // A 4xx won't be fixed by retrying (e.g. invalid event); drop it.
          if (response.status < 500) {
            warn(`daemon rejected event ${event.id}: HTTP ${response.status}`);
            return;
          }
          lastError = `HTTP ${response.status}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        if (attempt < retries) {
          await delay(retryDelayMs * (attempt + 1));
        }
      }
      warn(`could not deliver event ${event.id} after ${retries + 1} attempts (${lastError}); dropping it`);
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function resolveRecorderOptions(options: OpenCodeRecorderOptions): OpenCodeRecorderOptions {
  const resolved: OpenCodeRecorderOptions = {};
  const daemonUrl = options.daemonUrl ?? process.env.AGENT_BLACKBOX_DAEMON_URL;
  const runId = options.runId ?? process.env.AGENT_BLACKBOX_RUN_ID;
  if (daemonUrl) resolved.daemonUrl = daemonUrl;
  if (runId) resolved.runId = runId;
  if (options.cliPrompt) resolved.cliPrompt = options.cliPrompt;
  if (options.eventsFile) resolved.eventsFile = options.eventsFile;
  if (options.sink) resolved.sink = options.sink;
  if (options.homeDir) resolved.homeDir = options.homeDir;
  if (options.projectDir) resolved.projectDir = options.projectDir;
  if (typeof options.rawStored === "boolean") resolved.rawStored = options.rawStored;
  if (typeof options.optimize === "boolean") resolved.optimize = options.optimize;
  return resolved;
}
