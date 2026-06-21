import {
  computeEfficiencyReport,
  evaluatePromiseChecks,
  generateHandoffMarkdown,
  materializeWorkflowGraph,
  replayWorkflowGraphAtSeq,
  replayWorkflowGraphAtTime,
  type EfficiencyReport,
  type PromiseCheck,
  type TraceEvent,
  type WorkflowGraph,
  validateTraceEvent
} from "@agent-blackbox/core";
import { appendTraceEvent, readTraceEvents } from "@agent-blackbox/storage";
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
};

export type RunningTraceDaemon = {
  server: Server;
  port: number;
  eventsFile: string;
  close: () => Promise<void>;
};

export type TraceSnapshot = {
  events: TraceEvent[];
  graph: WorkflowGraph;
  checks: PromiseCheck[];
  efficiency: EfficiencyReport;
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
  const clients = new Set<WebSocket>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, eventsFile, clients, suggestConfig, options.projectDir);
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
      client.on("close", () => {
        clients.delete(client);
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
  const events = await loadTraceEvents(eventsFile);
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
  const handoffMarkdown = generateHandoffMarkdown(graph, checks);
  return {
    events,
    graph,
    checks,
    efficiency,
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
  projectDir: string
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
    // the headless recorder sends none, so both keep working.
    if (request.method === "POST") {
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
      const body = request.method === "POST" ? ((await readJsonBody(request)) as { report?: EfficiencyReport }) : {};
      const report =
        body.report && Array.isArray(body.report.metrics)
          ? body.report
          : (await buildTraceSnapshot(eventsFile, replay)).efficiency;
      const result = await generateSuggestions(report, suggestConfig);
      sendJson(response, 200, { ok: true, data: result });
      return;
    }
    // The actuator, exposed to the dashboard. GET previews the AGENTS.md memory
    // block (no write); POST .../apply writes it; POST .../revert removes it.
    // Every write is to a marked, reversible region — see optimize.ts.
    if (request.method === "GET" && url.pathname === "/optimize") {
      sendJson(response, 200, { ok: true, data: await runOptimize({ projectDir, eventsFile, mode: "preview" }) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/optimize/apply") {
      sendJson(response, 200, { ok: true, data: await runOptimize({ projectDir, eventsFile, mode: "apply" }) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/optimize/revert") {
      sendJson(response, 200, { ok: true, data: await runOptimize({ projectDir, eventsFile, mode: "revert" }) });
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
      await appendTraceEvent(eventsFile, body as TraceEvent);
      void broadcastSnapshot(clients, eventsFile);
      sendJson(response, 202, { ok: true, data: { accepted: true, id: (body as TraceEvent).id } });
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
  await Promise.allSettled([...clients].map((client) => sendSnapshot(client, eventsFile)));
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
