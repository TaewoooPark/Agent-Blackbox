import { createTraceEvent } from "@agent-blackbox/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReplaySummary, startTraceDaemon } from "./server.js";

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
});

