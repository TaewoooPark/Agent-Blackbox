import {
  computeEffectiveness,
  computeEfficiencyReport,
  evaluatePromiseChecks,
  generateHandoffMarkdown,
  materializeWorkflowGraph,
  replayWorkflowGraphAtSeq,
  replayWorkflowGraphAtTime,
  type EffectivenessReport,
  type EfficiencyReport,
  type PromiseCheck,
  type RulePack,
  type RunSummary,
  type TimelineEntry,
  type TraceEvent,
  type TraceHost,
  type WorkflowGraph,
  validateTraceEvent
} from "@agent-blackbox/core";
import { appendTraceEvent, parseTraceEvents, readTraceEvents } from "@agent-blackbox/storage";
import { updateBaselines } from "./baselineStore.js";
import { loadRulePacks } from "./ruleStore.js";
import { open, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { runOptimize } from "./optimize.js";
import { generateSuggestions, type SuggestionConfig } from "./suggestionProvider.js";

export type TraceDaemonOptions = {
  projectDir: string;
  port?: number;
  eventsFile?: string;
  suggest?: SuggestionConfig;
  // When set, the daemon records ONLY these hosts; an event from any other host is
  // dropped — not stored, not broadcast. `up --host claude-code` sets ["claude-code"]
  // so a leftover global OpenCode recorder (or the suggestion model's own
  // `opencode run`, which a stale recorder may still capture despite
  // AGENT_BLACKBOX_DISABLE) can't inject a foreign, trivial run that hijacks "latest"
  // and resets the score to 100. Unset / `--host all` records every host
  // (back-compat for the `daemon` command and project-scoped mode).
  recordHosts?: TraceHost[];
};

export type RunningTraceDaemon = {
  server: Server;
  port: number;
  eventsFile: string;
  // Append + broadcast a trace event in-process (same path as POST /events) so a
  // co-located recorder — e.g. the Claude Code transcript tailer — can feed the
  // daemon without an HTTP round-trip to itself.
  ingest: (event: TraceEvent) => Promise<void>;
  close: () => Promise<void>;
};

export type TraceSnapshot = {
  events: TraceEvent[];
  graph: WorkflowGraph;
  checks: PromiseCheck[];
  efficiency: EfficiencyReport;
  effectiveness: EffectivenessReport;
  // Recent per-run summaries (≤50) so the dashboard can score the run it's showing
  // against your usual run of the same archetype. Small; the heavy history stays
  // daemon-side.
  baselines: RunSummary[];
  // Optional custom rule packs keyed by project (cwd basename); the dashboard picks
  // the pack for the run it's VIEWING and evaluates it there. Only projects that
  // actually have a rules.json appear.
  rulePacks: Record<string, RulePack>;
  handoffMarkdown: string;
  replay: {
    mode: "live" | "seq" | "time";
    seq?: number;
    at?: string;
  };
};

type JsonResponse = {
  ok: boolean;
  data?: unknown;
  error?: { message: string; details?: unknown };
};

export async function startTraceDaemon(options: TraceDaemonOptions): Promise<RunningTraceDaemon> {
  const eventsFile = options.eventsFile ?? join(options.projectDir, ".agent-blackbox", "events.ndjson");
  const suggestConfig: SuggestionConfig = options.suggest ?? { mode: "auto" };
  const recordHosts =
    options.recordHosts && options.recordHosts.length > 0 ? new Set<TraceHost>(options.recordHosts) : null;
  const hostAllowed = (host: TraceHost): boolean => recordHosts === null || recordHosts.has(host);
  const clients = new Set<WebSocket>();
  const scheduleBroadcast = makeBroadcastScheduler(clients, eventsFile);
  const server = createServer((request, response) => {
    void handleRequest(request, response, eventsFile, clients, suggestConfig, options.projectDir, scheduleBroadcast, hostAllowed);
  });
  const streamServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    streamServer.handleUpgrade(request, socket, head, (client) => {
      clients.add(client);
      const drop = () => clients.delete(client);
      client.on("close", drop);
      // ws emits "error" with no default listener, so an unhandled socket error
      // (protocol fault, send-after-close) would throw and crash the long-lived
      // daemon. Consume it and reap the client.
      client.on("error", () => {
        drop();
        client.terminate();
      });
      void sendSnapshot(client, eventsFile);
    });
  });
  const port = options.port ?? 47831;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: actualPort,
    eventsFile,
    ingest: async (event: TraceEvent) => {
      if (!validateTraceEvent(event).ok) return;
      if (!hostAllowed(event.host)) return;
      await appendTraceEvent(eventsFile, event);
      scheduleBroadcast();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of clients) {
          client.terminate();
        }
        clients.clear();
        streamServer.close();
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
  };
}

export async function loadTraceEvents(eventsFile: string): Promise<TraceEvent[]> {
  try {
    return await readTraceEvents(eventsFile);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

// The dashboard snapshot must stay responsive no matter how large the global store
// grows (a heavy backfill can reach 100k+ events / tens of MB). Parse only the most
// recent slice of lines so building/shipping the snapshot is bounded; the latest
// run renders fully and recent runs populate the picker. Full history stays in the
// file and via GET /events.
export const SNAPSHOT_EVENT_CAP = 30_000;

// Incremental, capped, in-memory cache of recent events per file. The snapshot is
// rebuilt on every broadcast/poll; re-reading + re-splitting the whole (tens-of-MB)
// events file each time dominated daemon CPU on long sessions. Instead we read only
// the bytes appended since the last read, parse only the new lines, and keep the most
// recent SNAPSHOT_EVENT_CAP events in memory. Serialized per file so a broadcast build
// and a REST poll can't race the same cache.
type EventCache = { offset: number; buffer: string; events: TraceEvent[] };
const eventCaches = new Map<string, EventCache>();
const cacheLocks = new Map<string, Promise<unknown>>();

function withCacheLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = cacheLocks.get(key) ?? Promise.resolve();
  const result = prev.then(run, run);
  cacheLocks.set(key, result.then(() => undefined, () => undefined));
  return result;
}

export async function loadRecentTraceEvents(eventsFile: string, cap = SNAPSHOT_EVENT_CAP): Promise<TraceEvent[]> {
  return withCacheLock(eventsFile, async () => {
    let cache = eventCaches.get(eventsFile);
    if (!cache) {
      cache = { offset: 0, buffer: "", events: [] };
      eventCaches.set(eventsFile, cache);
    }
    let size: number;
    try {
      size = (await stat(eventsFile)).size;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    if (size < cache.offset) {
      // Truncated/rotated — restart from the top.
      cache.offset = 0;
      cache.buffer = "";
      cache.events = [];
    }
    if (size > cache.offset) {
      const handle = await open(eventsFile, "r");
      try {
        const length = size - cache.offset;
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, cache.offset);
        cache.offset = size;
        cache.buffer += buf.toString("utf8");
      } finally {
        await handle.close();
      }
      const lines = cache.buffer.split("\n");
      cache.buffer = lines.pop() ?? ""; // a torn final line stays buffered until completed
      // Cold read of a large pre-existing file: trim to the last cap lines before
      // parsing (the old bulk behavior). Incremental reads are tiny and skip this.
      let from = 0;
      if (cache.events.length === 0 && lines.length > SNAPSHOT_EVENT_CAP) {
        let kept = 0;
        from = lines.length;
        while (from > 0 && kept < SNAPSHOT_EVENT_CAP) {
          from -= 1;
          if (lines[from]!.trim().length > 0) kept += 1;
        }
      }
      const fresh = parseTraceEvents(lines.slice(from).join("\n"));
      if (fresh.length > 0) {
        cache.events.push(...fresh);
        if (cache.events.length > SNAPSHOT_EVENT_CAP) {
          cache.events.splice(0, cache.events.length - SNAPSHOT_EVENT_CAP);
        }
      }
    }
    // Apply the caller's cap at return time (decoupled from the cache size).
    return cap >= cache.events.length ? cache.events.slice() : cache.events.slice(cache.events.length - cap);
  });
}

export async function buildReplaySummary(eventsFile: string): Promise<{
  events: number;
  nodes: number;
  edges: number;
  runId: string;
}> {
  const events = await loadTraceEvents(eventsFile);
  const graph = materializeWorkflowGraph(events);
  return {
    events: events.length,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    runId: graph.runId
  };
}

export async function buildTraceSnapshot(
  eventsFile: string,
  replay: { seq?: number; at?: string } = {}
): Promise<TraceSnapshot> {
  const events = await loadRecentTraceEvents(eventsFile);
  const graph =
    replay.seq !== undefined
      ? replayWorkflowGraphAtSeq(events, replay.seq)
      : replay.at !== undefined
        ? replayWorkflowGraphAtTime(events, replay.at)
        : materializeWorkflowGraph(events);
  const replayedEvents = new Set(graph.appliedEventIds);
  const visibleEvents = events.filter((event) => replayedEvents.has(event.id));
  const checks = evaluatePromiseChecks(visibleEvents);
  const efficiency = computeEfficiencyReport(visibleEvents);
  const effectiveness = computeEffectiveness(visibleEvents, checks);
  // Best-effort: records recent runs (throttled) and returns the rolling history.
  // Pass the whole-file events so every run is summarised, not just the visible one.
  const baselines = await updateBaselines(eventsFile, events);
  const rulePacks = await loadRulePacks(events);
  const handoffMarkdown = generateHandoffMarkdown(graph, checks);
  return {
    events,
    graph,
    checks,
    efficiency,
    effectiveness,
    baselines,
    rulePacks,
    handoffMarkdown,
    replay: {
      mode: replay.seq !== undefined ? "seq" : replay.at !== undefined ? "time" : "live",
      ...(replay.seq !== undefined ? { seq: replay.seq } : {}),
      ...(replay.at !== undefined ? { at: replay.at } : {})
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  eventsFile: string,
  clients: Set<WebSocket>,
  suggestConfig: SuggestionConfig,
  projectDir: string,
  scheduleBroadcast: () => void,
  hostAllowed: (host: TraceHost) => boolean
): Promise<void> {
  try {
    applyCors(request, response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "OPTIONS") {
      sendEmpty(response, 204);
      return;
    }
    // CORS withholds the allow-origin header on cross-site reads but does not stop a
    // browser from *sending* a CORS-simple POST (text/plain or body-less), so the
    // mutating routes still fire their side effects. Reject the request outright when
    // it carries a non-loopback Origin. The dashboard always sends a loopback Origin;
    // the headless recorder sends none, so both keep working. GET /suggest is a
    // CORS-simple request with side effects (it can spawn an opencode subprocess and
    // make outbound LLM calls), so it gets the same guard despite not being a POST.
    if (request.method === "POST" || url.pathname === "/suggest") {
      const origin = request.headers.origin;
      if (typeof origin === "string" && !isLoopbackOrigin(origin)) {
        sendJson(response, 403, { ok: false, error: { message: "cross-site request blocked" } });
        return;
      }
    }
    const replay = parseReplayQuery(url);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, data: { status: "ok", eventsFile } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      sendJson(response, 200, { ok: true, data: await loadTraceEvents(eventsFile) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/graph") {
      sendJson(response, 200, { ok: true, data: (await buildTraceSnapshot(eventsFile, replay)).graph });
      return;
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      sendJson(response, 200, { ok: true, data: await buildTraceSnapshot(eventsFile, replay) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/efficiency") {
      sendJson(response, 200, { ok: true, data: (await buildTraceSnapshot(eventsFile, replay)).efficiency });
      return;
    }
    if (request.method === "GET" && url.pathname === "/audit") {
      sendJson(response, 200, { ok: true, data: (await buildTraceSnapshot(eventsFile, replay)).checks });
      return;
    }
    if (request.method === "GET" && url.pathname === "/handoff") {
      sendJson(response, 200, {
        ok: true,
        data: { markdown: (await buildTraceSnapshot(eventsFile, replay)).handoffMarkdown }
      });
      return;
    }
    if (url.pathname === "/suggest" && (request.method === "POST" || request.method === "GET")) {
      // POST a client-computed report (keeps it consistent with the per-run panel);
      // GET falls back to the whole-file report.
      const body =
        request.method === "POST"
          ? ((await readJsonBody(request)) as { report?: EfficiencyReport; timeline?: TimelineEntry[] })
          : {};
      const report =
        body.report && Array.isArray(body.report.metrics)
          ? body.report
          : (await buildTraceSnapshot(eventsFile, replay)).efficiency;
      // The client (which has the viewed run's events) may attach a redacted causal
      // timeline so advice respects compaction boundaries; tolerate its absence.
      const timeline = Array.isArray(body.timeline) ? body.timeline : undefined;
      const result = await generateSuggestions(report, suggestConfig, timeline);
      sendJson(response, 200, { ok: true, data: result });
      return;
    }
    // The actuator, exposed to the dashboard. GET previews the AGENTS.md memory
    // block (no write); POST .../apply writes it; POST .../revert removes it.
    // Every write is to a marked, reversible region — see optimize.ts.
    // The dashboard passes ?runId=<the run it's showing> so optimize acts on that
    // run, not whichever is globally-latest (they differ when several sessions run
    // at once). Omitted → the actuator falls back to the most recent run.
    const optimizeRunId = url.searchParams.get("runId") || undefined;
    if (request.method === "GET" && url.pathname === "/optimize") {
      sendJson(response, 200, {
        ok: true,
        data: await runOptimize({ projectDir, eventsFile, mode: "preview", ...(optimizeRunId ? { runId: optimizeRunId } : {}) })
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/optimize/apply") {
      sendJson(response, 200, {
        ok: true,
        data: await runOptimize({ projectDir, eventsFile, mode: "apply", ...(optimizeRunId ? { runId: optimizeRunId } : {}) })
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/optimize/revert") {
      sendJson(response, 200, {
        ok: true,
        data: await runOptimize({ projectDir, eventsFile, mode: "revert", ...(optimizeRunId ? { runId: optimizeRunId } : {}) })
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/events") {
      const body = await readJsonBody(request);
      const validation = validateTraceEvent(body);
      if (!validation.ok) {
        sendJson(response, 400, {
          ok: false,
          error: { message: "Invalid TraceEvent", details: validation.errors }
        });
        return;
      }
      const event = body as TraceEvent;
      // Host scoping: when the daemon is started for a specific host (e.g.
      // `up --host claude-code`), drop events from any other host. A leftover global
      // OpenCode recorder — or the suggestion model's own `opencode run` — would
      // otherwise post a trivial foreign run that hijacks "latest" and resets the
      // score to 100. Ack with accepted:false so the recorder doesn't error/retry,
      // but neither store nor broadcast it.
      if (!hostAllowed(event.host)) {
        sendJson(response, 202, {
          ok: true,
          data: { accepted: false, reason: `host ${event.host} is not recorded by this daemon` }
        });
        return;
      }
      await appendTraceEvent(eventsFile, event);
      scheduleBroadcast();
      sendJson(response, 202, { ok: true, data: { accepted: true, id: event.id } });
      return;
    }
    sendJson(response, 404, { ok: false, error: { message: "Not found" } });
  } catch (error) {
    sendJson(response, error instanceof BadRequestError ? 400 : 500, {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function broadcastSnapshot(clients: Set<WebSocket>, eventsFile: string): Promise<void> {
  if (clients.size === 0) {
    return;
  }
  // Build + serialize the snapshot ONCE, then fan the same frame out to every client —
  // not once per client (which re-ran the whole O(N) graph build per socket).
  let frame: string;
  try {
    frame = JSON.stringify({ type: "snapshot", data: await buildTraceSnapshot(eventsFile) });
  } catch (error) {
    const errFrame = JSON.stringify({
      type: "error",
      error: { message: error instanceof Error ? error.message : String(error) }
    });
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(errFrame);
    return;
  }
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(frame);
}

// Coalesce rapid broadcasts (the tailer can ingest many events per poll tick, each
// otherwise rebuilding the whole snapshot) into at most one per `delayMs`. Builds are
// SERIALIZED — a new request that arrives while one is in flight is collapsed into a
// single trailing rebuild — so on a large log the ~O(N) build can't overlap itself and
// back up the event loop; the rate self-limits to one build per (buildTime + delayMs).
function makeBroadcastScheduler(clients: Set<WebSocket>, eventsFile: string, delayMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  let pending = false;
  const schedule = (): void => {
    if (building) {
      pending = true; // a build is running — remember to rebuild once it finishes
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      building = true;
      void broadcastSnapshot(clients, eventsFile).finally(() => {
        building = false;
        if (pending) {
          pending = false;
          schedule();
        }
      });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  return schedule;
}

async function sendSnapshot(client: WebSocket, eventsFile: string): Promise<void> {
  if (client.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    client.send(JSON.stringify({ type: "snapshot", data: await buildTraceSnapshot(eventsFile) }));
  } catch (error) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "error",
          error: { message: error instanceof Error ? error.message : String(error) }
        })
      );
    }
  }
}

const MAX_BODY_BYTES = 50_000_000;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new BadRequestError("Request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}

// Only same-machine (loopback) origins may drive the daemon from a browser. The
// dashboard (127.0.0.1:<uiPort>) is cross-port → cross-origin, so it needs CORS;
// but a wildcard let any website the user visits POST to 127.0.0.1 and drive the
// mutating routes (/events, /optimize/apply) as a CSRF. Reflect the Origin only
// when it's loopback; non-browser callers (the CLI recorder) send no Origin and
// aren't subject to CORS anyway.
function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (typeof origin === "string" && isLoopbackOrigin(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: JsonResponse): void {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  response.end();
}

function parseReplayQuery(url: URL): { seq?: number; at?: string } {
  const seq = url.searchParams.get("seq");
  if (seq !== null && seq !== "") {
    const parsed = Number(seq);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestError("seq must be a non-negative integer");
    }
    return { seq: parsed };
  }
  const at = url.searchParams.get("at");
  if (at !== null && at !== "") {
    if (Number.isNaN(Date.parse(at))) {
      throw new BadRequestError("at must be an ISO-compatible timestamp");
    }
    return { at };
  }
  return {};
}

class BadRequestError extends Error {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
