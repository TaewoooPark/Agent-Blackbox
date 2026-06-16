import {
  evaluatePromiseChecks,
  generateHandoffMarkdown,
  materializeWorkflowGraph,
  replayWorkflowGraphAtSeq,
  replayWorkflowGraphAtTime,
  type PromiseCheck,
  type TraceEvent,
  type WorkflowGraph,
  validateTraceEvent
} from "@agent-blackbox/core";
import { appendTraceEvent, readTraceEvents } from "@agent-blackbox/storage";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

export type TraceDaemonOptions = {
  projectDir: string;
  port?: number;
  eventsFile?: string;
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
  const clients = new Set<WebSocket>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, eventsFile, clients);
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
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: actualPort,
    eventsFile,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          streamServer.close();
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
  const handoffMarkdown = generateHandoffMarkdown(graph, checks);
  return {
    events,
    graph,
    checks,
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
  clients: Set<WebSocket>
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const replay = parseReplayQuery(url);
    if (request.method === "OPTIONS") {
      sendEmpty(response, 204);
      return;
    }
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
}

function sendJson(response: ServerResponse, statusCode: number, payload: JsonResponse): void {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*"
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
