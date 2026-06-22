import { createTraceEvent } from "@agent-blackbox/core";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildReplaySummary, buildTraceSnapshot, loadRecentTraceEvents, startTraceDaemon } from "./server.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("snapshot scale cap", () => {
  it("parses only the most recent `cap` events so the snapshot stays bounded", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "abb-cap-"));
    const eventsFile = join(tempDir, "events.ndjson");
    const events = Array.from({ length: 50 }, (_, i) =>
      createTraceEvent(i + 1, {
        host: "claude-code",
        runId: "r",
        sessionId: "r",
        kind: "file_read",
        payload: { path: `f${i}.ts`, chars: 1 },
        ts: `2026-06-21T00:00:${String(i).padStart(2, "0")}.000Z`
      })
    );
    await writeFile(eventsFile, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    const recent = await loadRecentTraceEvents(eventsFile, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0]?.seq).toBe(41); // last 10 (seq 41..50)
    expect(recent[9]?.seq).toBe(50);
  });

  const ev = (seq: number) =>
    createTraceEvent(seq, {
      host: "claude-code",
      runId: "r",
      sessionId: "r",
      kind: "file_read",
      payload: { path: `f${seq}.ts`, chars: 1 },
      ts: `2026-06-21T00:00:${String(seq).padStart(2, "0")}.000Z`
    });

  it("reads incrementally — appended events are picked up without re-reading from the top", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "abb-incr-"));
    const eventsFile = join(tempDir, "events.ndjson");
    await writeFile(eventsFile, `${[ev(1), ev(2)].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    expect((await loadRecentTraceEvents(eventsFile)).map((e) => e.seq)).toEqual([1, 2]);
    await appendFile(eventsFile, `${JSON.stringify(ev(3))}\n`, "utf8");
    expect((await loadRecentTraceEvents(eventsFile)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("resets the cache when the file is truncated/rotated", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "abb-trunc-"));
    const eventsFile = join(tempDir, "events.ndjson");
    await writeFile(eventsFile, `${[ev(1), ev(2), ev(3)].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    expect(await loadRecentTraceEvents(eventsFile)).toHaveLength(3);
    await writeFile(eventsFile, `${JSON.stringify(ev(9))}\n`, "utf8"); // shorter file → truncation
    expect((await loadRecentTraceEvents(eventsFile)).map((e) => e.seq)).toEqual([9]);
  });
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

  it("reflects CORS only for loopback origins (blocks cross-site)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    try {
      // The dashboard (127.0.0.1:<uiPort>) is a loopback origin → reflected.
      const local = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "OPTIONS",
        headers: { origin: "http://127.0.0.1:5173" }
      });
      expect(local.status).toBe(204);
      expect(local.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
      expect(local.headers.get("access-control-allow-methods")).toContain("POST");

      // A random website must NOT be allowed to drive the daemon from a browser.
      const evil = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" }
      });
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await daemon.close();
    }
  });

  it("rejects cross-site POSTs but allows loopback + headless (CSRF guard)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    const mk = (seq: number, path: string) =>
      JSON.stringify(createTraceEvent(seq, { host: "opencode", runId: "r", sessionId: "s", kind: "file_read", payload: { path } }));
    try {
      // A malicious page's cross-origin POST (browsers always attach Origin, and it
      // can't be forged by JS) must be rejected even though it's a CORS-simple write.
      const evil = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: mk(1, "evil.ts")
      });
      expect(evil.status).toBe(403);

      // GET /suggest has side effects (it can spawn opencode), so a cross-site GET is
      // blocked too — rejected before any spawn.
      const evilSuggest = await fetch(`http://127.0.0.1:${daemon.port}/suggest`, {
        headers: { origin: "https://evil.example" }
      });
      expect(evilSuggest.status).toBe(403);

      // Dashboard (loopback Origin) and the headless recorder (no Origin) both work.
      const local = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: mk(1, "ok.ts")
      });
      expect(local.status).toBe(202);
      const headless = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: mk(2, "ok2.ts")
      });
      expect(headless.status).toBe(202);

      // Only the two allowed writes landed — the cross-site one never fired.
      const listed = (await (await fetch(`http://127.0.0.1:${daemon.port}/events`)).json()) as { data: unknown[] };
      expect(listed.data).toHaveLength(2);
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

  it("broadcasts one build to every connected client (build-once fan-out)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-daemon-"));
    const daemon = await startTraceDaemon({ projectDir: tempDir, port: 0 });
    const a = new WebSocket(`ws://127.0.0.1:${daemon.port}/stream`);
    const b = new WebSocket(`ws://127.0.0.1:${daemon.port}/stream`);
    try {
      await Promise.all([nextSocketMessage(a), nextSocketMessage(b)]); // initial snapshots
      const event = createTraceEvent(1, {
        host: "opencode",
        runId: "run-fanout",
        sessionId: "session-fanout",
        kind: "file_read",
        payload: { path: "src/x.ts" }
      });
      const bothUpdated = Promise.all([nextSocketMessage(a), nextSocketMessage(b)]);
      const ingest = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });
      expect(ingest.status).toBe(202);
      const [ua, ub] = await bothUpdated; // both clients receive the single built snapshot
      expect(ua.data.graph).toMatchObject({ runId: "run-fanout" });
      expect(ub.data.graph).toMatchObject({ runId: "run-fanout" });
    } finally {
      a.close();
      b.close();
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
