import type { TraceEvent } from "@agent-blackbox/core";
import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultCodexSessionsDir, startCodexTailer } from "./tailer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("timed out waiting for Codex tailer");
}

describe("Codex transcript tailer", () => {
  it("respects CODEX_HOME", () => {
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(tmpdir(), "custom-codex");
    try {
      expect(defaultCodexSessionsDir("/unused")).toBe(join(process.env.CODEX_HOME, "sessions"));
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
    }
  });

  it("tails new rollout lines and primes existing subagent metadata from the first line", async () => {
    const root = await mkdtemp(join(tmpdir(), "abb-codex-tail-"));
    const sessionsDir = join(root, "sessions", "2026", "07", "15");
    await mkdir(sessionsDir, { recursive: true });
    const rootId = "019f64f4-4b7c-75e2-bb37-c285d74b2ddd";
    const childId = "019f64f4-5281-7623-be64-8aa7682dd65b";
    const file = join(sessionsDir, `rollout-2026-07-15T08-46-01-${childId}.jsonl`);
    const meta = { timestamp: "2026-07-15T08:46:01.000Z", type: "session_meta", payload: { id: childId, session_id: rootId, parent_thread_id: rootId, thread_source: "subagent", agent_path: "/root/reviewer", cwd: "/project" } };
    await writeFile(file, `${JSON.stringify(meta)}\n`, "utf8");
    const events: TraceEvent[] = [];
    const tailer = await startCodexTailer({ write: async (event) => { events.push(event); } }, { sessionsDir: join(root, "sessions"), pollMs: 20 });
    cleanups.push(async () => { tailer.stop(); await rm(root, { recursive: true, force: true }); });
    await appendFile(file, `${JSON.stringify({ timestamp: "2026-07-15T08:46:02.000Z", type: "event_msg", payload: { type: "user_message", message: "review this" } })}\n`);
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ host: "codex", runId: rootId, sessionId: rootId, agentRole: "subagent", agentId: "/root/reviewer", kind: "message" });
  });

  it("backfills recent rollouts and skips malformed lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "abb-codex-backfill-"));
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const id = "019f64f4-4b7c-75e2-bb37-c285d74b2ddd";
    const file = join(sessionsDir, `rollout-${id}.jsonl`);
    await writeFile(file, `${JSON.stringify({ timestamp: "2026-07-15T08:46:01.000Z", type: "session_meta", payload: { id, session_id: id, cwd: "/project" } })}\n{bad json\n`, "utf8");
    const events: TraceEvent[] = [];
    const tailer = await startCodexTailer({ write: async (event) => { events.push(event); } }, { sessionsDir, pollMs: 20, backfillDays: 9999 });
    cleanups.push(async () => { tailer.stop(); await rm(root, { recursive: true, force: true }); });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ host: "codex", kind: "session_created" });
  });
});
