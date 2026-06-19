import { createTraceEvent } from "@agent-blackbox/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildReplaySummary, buildTraceSnapshot, startTraceDaemon } from "./server.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("trace daemon", () => {
  it("accepts events and serves a replayed graph", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    try {
      const event = createTraceEvent(1, {
        host: "opencode",
        runId: "run-daemon",
        sessionId: "session-daemon",
        agentId: "agent-daemon",
        kind: "file_read",
        payload: { path: "src/index.ts" }
      });

      const ingest = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
      expect(ingest.status).toBe(202);

      const graphResponse = await fetch(`http://127.0.0.1:${daemon.port}/graph`);
      const graphPayload = (await graphResponse.json()) as {
        ok: boolean;
        data: { nodes: { type: string; label: string }[] };
      };

      expect(graphPayload.ok).toBe(true);
      expect(graphPayload.data.nodes.some((node) => node.type === "FILE" && node.label === "src/index.ts")).toBe(true);
      await expect(buildReplaySummary(daemon.eventsFile)).resolves.toMatchObject({
        events: 1,
        runId: "run-daemon"
      });
    } finally {
      await daemon.close();
    }
  });

  it("rejects malformed events", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    try {
      const ingest = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "not-enough" })
      });

      expect(ingest.status).toBe(400);
    } finally {
      await daemon.close();
    }
  });

  it("serves local dashboard CORS headers and preflight", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    try {
      const preflight = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "OPTIONS"
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

      const health = await fetch(`http://127.0.0.1:${daemon.port}/health`);
      expect(health.headers.get("access-control-allow-methods")).toContain("POST");
    } finally {
      await daemon.close();
    }
  });

  it("serves replay snapshots, audit checks, and handoff markdown", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    try {
      const events = [
        createTraceEvent(1, {
          host: "opencode",
          runId: "run-snapshot",
          sessionId: "session-snapshot",
          agentId: "agent-primary",
          kind: "message",
          payload: { role: "assistant", text: "I ran the tests and updated the implementation." }
        }),
        createTraceEvent(2, {
          host: "opencode",
          runId: "run-snapshot",
          sessionId: "session-snapshot",
          agentId: "agent-primary",
          kind: "file_edit",
          payload: { path: "src/index.ts" }
        }),
        createTraceEvent(3, {
          host: "opencode",
          runId: "run-snapshot",
          sessionId: "session-snapshot",
          agentId: "agent-primary",
          kind: "bash",
          payload: { command: "npm test", exitCode: 0 }
        })
      ];

      for (const event of events) {
        const ingest = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event)
        });
        expect(ingest.status).toBe(202);
      }

      const replayResponse = await fetch(`http://127.0.0.1:${daemon.port}/snapshot?seq=1`);
      const replayPayload = (await replayResponse.json()) as {
        ok: boolean;
        data: { graph: { appliedEventIds: string[] }; checks: { status: string }[] };
      };
      expect(replayPayload.ok).toBe(true);
      expect(replayPayload.data.graph.appliedEventIds).toEqual(["evt_run-snapshot_000001"]);
      expect(replayPayload.data.checks.map((check) => check.status)).toEqual(["unverified", "unverified"]);

      const auditResponse = await fetch(`http://127.0.0.1:${daemon.port}/audit`);
      const auditPayload = (await auditResponse.json()) as {
        ok: boolean;
        data: { status: string; evidenceEventIds: string[] }[];
      };
      expect(auditPayload.data.map((check) => check.status)).toEqual(["verified", "verified"]);
      expect(auditPayload.data.flatMap((check) => check.evidenceEventIds)).toContain("evt_run-snapshot_000003");

      const handoffResponse = await fetch(`http://127.0.0.1:${daemon.port}/handoff`);
      const handoffPayload = (await handoffResponse.json()) as { ok: boolean; data: { markdown: string } };
      expect(handoffPayload.data.markdown).toContain("## Promise Checks");

      const efficiencyResponse = await fetch(`http://127.0.0.1:${daemon.port}/efficiency`);
      const efficiencyPayload = (await efficiencyResponse.json()) as {
        ok: boolean;
        data: { overallScore: number; metrics: { id: string }[] };
      };
      expect(efficiencyPayload.ok).toBe(true);
      expect(typeof efficiencyPayload.data.overallScore).toBe("number");
      expect(efficiencyPayload.data.metrics.map((m) => m.id)).toContain("redundant-reads");

      await expect(buildTraceSnapshot(daemon.eventsFile, { seq: 2 })).resolves.toMatchObject({
        replay: { mode: "seq", seq: 2 },
        graph: { runId: "run-snapshot" }
      });
    } finally {
      await daemon.close();
    }
  });

  it("rejects invalid replay queries as bad requests", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}/snapshot?seq=nope`);
      const payload = (await response.json()) as { ok: boolean; error: { message: string } };

      expect(response.status).toBe(400);
      expect(payload.ok).toBe(false);
      expect(payload.error.message).toContain("seq");
    } finally {
      await daemon.close();
    }
  });

  it("previews, applies, and reverts the AGENTS.md efficiency memory over HTTP", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    const base = `http://127.0.0.1:${daemon.port}`;
    const agentsMd = join(tempDir, "AGENTS.md");
    try {
      // A wasteful run: same file read twice then edited → redundant-reads fires,
      // so there's a memory block worth pinning.
      const events = [
        createTraceEvent(1, {
          host: "opencode",
          runId: "run-opt",
          sessionId: "s",
          kind: "file_read",
          payload: { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }
        }),
        createTraceEvent(2, {
          host: "opencode",
          runId: "run-opt",
          sessionId: "s",
          kind: "file_read",
          payload: { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }
        }),
        createTraceEvent(3, {
          host: "opencode",
          runId: "run-opt",
          sessionId: "s",
          kind: "file_edit",
          payload: { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 100 }
        })
      ];
      for (const event of events) {
        const ingest = await fetch(`${base}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event)
        });
        expect(ingest.status).toBe(202);
      }

      // Preview writes nothing but returns the exact block + applied=false.
      const preview = (await (await fetch(`${base}/optimize`)).json()) as {
        ok: boolean;
        data: { block: string | null; applied: boolean; changed: boolean };
      };
      expect(preview.ok).toBe(true);
      expect(preview.data.block).toContain("Context-efficiency notes");
      expect(preview.data.applied).toBe(false);
      await expect(readFile(agentsMd, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      // Apply writes the managed block and reports applied=true.
      const applied = (await (await fetch(`${base}/optimize/apply`, { method: "POST" })).json()) as {
        ok: boolean;
        data: { applied: boolean; changed: boolean };
      };
      expect(applied.data.applied).toBe(true);
      expect(applied.data.changed).toBe(true);
      expect(await readFile(agentsMd, "utf8")).toContain("agent-blackbox:efficiency:start");

      // A fresh preview now sees the block in place.
      const reread = (await (await fetch(`${base}/optimize`)).json()) as { data: { applied: boolean } };
      expect(reread.data.applied).toBe(true);

      // Revert strips it back out.
      const reverted = (await (await fetch(`${base}/optimize/revert`, { method: "POST" })).json()) as {
        data: { applied: boolean; changed: boolean };
      };
      expect(reverted.data.applied).toBe(false);
      expect(reverted.data.changed).toBe(true);
      await expect(readFile(agentsMd, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await daemon.close();
    }
  });

  it("pushes live snapshots over the stream websocket", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/stream`);
    try {
      const initial = await nextSocketMessage(socket);
      expect(initial).toMatchObject({ type: "snapshot", data: { events: [] } });

      const event = createTraceEvent(1, {
        host: "opencode",
        runId: "run-stream",
        sessionId: "session-stream",
        agentId: "agent-stream",
        kind: "file_read",
        payload: { path: "src/live.ts" }
      });
      const ingest = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
      expect(ingest.status).toBe(202);

      const update = await nextSocketMessage(socket);
      expect(update).toMatchObject({
        type: "snapshot",
        data: { graph: { runId: "run-stream" } }
      });
      expect(update.data.events).toHaveLength(1);
    } finally {
      socket.close();
      await daemon.close();
    }
  });
});

function nextSocketMessage(socket: WebSocket): Promise<{ type: string; data: { events: unknown[]; graph?: unknown } }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message"));
    }, 2000);
    const onMessage = (raw: RawData) => {
      cleanup();
      resolve(JSON.parse(raw.toString()) as { type: string; data: { events: unknown[]; graph?: unknown } });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}
