import { materializeWorkflowGraph, type TraceEvent, validateTraceEvent } from "@agent-blackbox/core";
import { appendTraceEvent, readTraceEvents } from "@agent-blackbox/storage";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

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

type JsonResponse = {
  ok: boolean;
  data?: unknown;
  error?: { message: string; details?: unknown };
};

export async function startTraceDaemon(options: TraceDaemonOptions): Promise<RunningTraceDaemon> {
  const eventsFile = options.eventsFile ?? join(options.projectDir, ".agent-blackbox", "events.ndjson");
  const server = createServer((request, response) => {
    void handleRequest(request, response, eventsFile);
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

async function handleRequest(request: IncomingMessage, response: ServerResponse, eventsFile: string): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, data: { status: "ok", eventsFile } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      sendJson(response, 200, { ok: true, data: await loadTraceEvents(eventsFile) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/graph") {
      const events = await loadTraceEvents(eventsFile);
      sendJson(response, 200, { ok: true, data: materializeWorkflowGraph(events) });
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
      sendJson(response, 202, { ok: true, data: { accepted: true, id: (body as TraceEvent).id } });
      return;
    }
    sendJson(response, 404, { ok: false, error: { message: "Not found" } });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) }
    });
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
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

