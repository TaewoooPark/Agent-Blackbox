import { createTraceEvent } from "@agent-blackbox/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendTraceEvent, parseTraceEvents, readTraceEvents, serializeTraceEvent } from "./ndjson.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("trace NDJSON", () => {
  it("serializes and parses valid trace events", () => {
    const event = createTraceEvent(1, {
      host: "opencode",
      runId: "run-ndjson",
      sessionId: "session-ndjson",
      kind: "file_read",
      payload: { path: "src/index.ts" }
    });

    const serialized = serializeTraceEvent(event);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(parseTraceEvents(serialized)).toEqual([event]);
  });

  it("appends trace events to disk", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-"));
    const filePath = join(tempDir, ".agent-blackbox", "events.ndjson");
    const first = createTraceEvent(1, {
      host: "opencode",
      runId: "run-disk",
      sessionId: "session-disk",
      kind: "session_created"
    });
    const second = createTraceEvent(2, {
      host: "opencode",
      runId: "run-disk",
      sessionId: "session-disk",
      kind: "bash",
      payload: { command: "npm test", exitCode: 0 }
    });

    await appendTraceEvent(filePath, first);
    await appendTraceEvent(filePath, second);

    expect((await readFile(filePath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
    expect(await readTraceEvents(filePath)).toEqual([first, second]);
  });
});

