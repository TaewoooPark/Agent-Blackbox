import { createTraceEvent, dominantCwd, projectKey, type TraceEvent } from "@agent-blackbox/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startTraceDaemon } from "./server.js";

// A Windows-shaped event: drive-letter cwd + backslash file path, exactly what a
// Windows host posts. The daemon must validate it, persist to NDJSON, read it back,
// and materialize a graph without choking on the separator — and core must key the
// project off the C:\ cwd. This guards the whole-product Windows path of the recorder.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const winEvent = (): TraceEvent =>
  createTraceEvent(1, {
    host: "claude-code",
    runId: "win-run",
    sessionId: "win-run",
    kind: "file_read",
    payload: { path: "C:\\proj\\src\\foo.ts" } as never,
    cwd: "C:\\proj"
  });

describe("windows-shaped events", () => {
  it("round-trip through the daemon: POST /events → /snapshot reflects it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "abb-win-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const daemon = await startTraceDaemon({ projectDir: dir, port: 0 });
    cleanups.push(() => daemon.close());

    const event = winEvent();
    const post = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
    expect(post.status).toBe(202);
    expect((await post.json()).data).toMatchObject({ accepted: true });

    const snapshot = (await (await fetch(`http://127.0.0.1:${daemon.port}/snapshot`)).json()).data;
    expect(snapshot.events.map((e: TraceEvent) => e.id)).toContain(event.id);
    expect(snapshot.graph.nodes.length).toBeGreaterThan(0);
  });

  it("core keys the project off the drive-letter cwd", () => {
    expect(dominantCwd([winEvent()])).toBe("C:\\proj");
    expect(projectKey([winEvent()])).toBe("proj");
  });
});
