import { createTraceEvent } from "@agent-blackbox/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpTraceSink } from "./sink.js";

const event = createTraceEvent(1, {
  host: "opencode",
  runId: "run-sink",
  sessionId: "session-sink",
  kind: "session_updated"
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http trace sink", () => {
  it("retries a transient failure and then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return new Response(null, { status: 202 });
    });
    const warnings: string[] = [];
    const sink = createHttpTraceSink("http://127.0.0.1:47831", { retries: 3, retryDelayMs: 0, onWarn: (m) => warnings.push(m) });

    await expect(sink.write(event)).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(warnings).toHaveLength(0);
  });

  it("never throws on persistent failure, warns once, and drops the event", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    });
    const warnings: string[] = [];
    const sink = createHttpTraceSink("http://127.0.0.1:47831", { retries: 2, retryDelayMs: 0, onWarn: (m) => warnings.push(m) });

    await expect(sink.write(event)).resolves.toBeUndefined();
    expect(calls).toBe(3); // initial + 2 retries
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("dropping it");
  });

  it("does not retry a 4xx rejection", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(null, { status: 400 });
    });
    const warnings: string[] = [];
    const sink = createHttpTraceSink("http://127.0.0.1:47831", { retries: 3, retryDelayMs: 0, onWarn: (m) => warnings.push(m) });

    await expect(sink.write(event)).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(warnings[0]).toContain("HTTP 400");
  });

  it("sends exactly one request on success", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    });
    const sink = createHttpTraceSink("http://127.0.0.1:47831", { retryDelayMs: 0 });

    await sink.write(event);
    expect(calls).toBe(1);
  });
});
