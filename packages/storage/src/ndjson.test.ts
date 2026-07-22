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

  it("serializes concurrent appends without interleaving (no torn interior lines)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-"));
    const filePath = join(tempDir, ".agent-blackbox", "events.ndjson");
    // Large payloads (span several write() syscalls) fired concurrently — the
    // exact shape that interleaves at EOF without per-path serialization.
    const big = "x".repeat(64_000);
    const events = Array.from({ length: 40 }, (_unused, i) =>
      createTraceEvent(i + 1, {
        host: "opencode",
        runId: "run-concurrent",
        sessionId: "s",
        kind: "message",
        payload: { role: "assistant", text: `${i}:${big}` }
      })
    );

    await Promise.all(events.map((e) => appendTraceEvent(filePath, e)));

    // Every line is intact JSON and all 40 events survive (order may vary).
    const parsed = await readTraceEvents(filePath);
    expect(parsed).toHaveLength(40);
    expect(new Set(parsed.map((e) => e.id)).size).toBe(40);
  });

  it("reads a store larger than one read chunk, intact across boundaries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-"));
    const filePath = join(tempDir, ".agent-blackbox", "events.ndjson");
    // Exceed the 8 MiB streaming read chunk so the reader loops and lines (and a
    // multibyte char) straddle chunk boundaries — the case that a single-string
    // read handled implicitly but that also crashes once a store passes ~512 MB.
    const pad = "x".repeat(1_000);
    const count = 10_000; // ~10 MB serialized
    const events = Array.from({ length: count }, (_unused, i) =>
      createTraceEvent(i + 1, {
        host: "opencode",
        runId: "run-big",
        sessionId: "s",
        kind: "message",
        // A multibyte marker mid-store lands near a chunk edge for at least one event.
        payload: { role: "assistant", text: `${i}:日本語🎉:${pad}` }
      })
    );
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, events.map(serializeTraceEvent).join(""), "utf8");

    const parsed = await readTraceEvents(filePath);
    expect(parsed).toHaveLength(count);
    expect(parsed[0]).toEqual(events[0]);
    expect(parsed[count - 1]).toEqual(events[count - 1]);
    // Multibyte content survives the chunked decode.
    expect(parsed.every((e, i) => (e.payload as { text: string }).text === `${i}:日本語🎉:${pad}`)).toBe(true);
  });
});

