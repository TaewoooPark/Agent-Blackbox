import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent } from "@agent-blackbox/core";
import { startGjcTailer } from "./tailer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const session = (id = "019efd8a-f6b8-7000-be44-30cc188e7dc5") =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-25T00:00:00.000Z", cwd: "/tmp/project" });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "abb-gjc-tail-"));
  const sessionsDir = join(root, "sessions", "-Workspace-project");
  await mkdir(sessionsDir, { recursive: true });
  const events: TraceEvent[] = [];
  const file = (name: string) => join(sessionsDir, name);
  const start = async (opts: { backfillDays?: number } = {}) => {
    const tailer = await startGjcTailer({ write: async (e) => { events.push(e); } }, { sessionsDir: join(root, "sessions"), pollMs: 20, ...opts });
    cleanups.push(async () => {
      tailer.stop();
      await rm(root, { recursive: true, force: true });
    });
    return tailer;
  };
  return { file, events, start };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for tailer condition");
}

describe("gjc tailer", () => {
  it("skips malformed lines, buffers partial lines, and emits completed records", async () => {
    const { file, events, start } = await harness();
    await writeFile(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5.jsonl"), `${session()}\n{ not json,,\n${session("sess-2")}\n{\"type\":\"model_change\",\"model\":\"x`, "utf8");
    await start({ backfillDays: 9999 });
    await waitFor(() => events.length === 2);
    await appendFile(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5.jsonl"), "\"}\n");
    await waitFor(() => events.length === 3);
    expect(events.every((e) => e.host === "gjc")).toBe(true);
  });

  it("tails current end by default and captures new lines only", async () => {
    const { file, events, start } = await harness();
    await writeFile(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5.jsonl"), `${session()}\n`, "utf8");
    await start();
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(0);
    await appendFile(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5.jsonl"), `${session("sess-2")}\n`);
    await waitFor(() => events.length === 1);
  });

  it("picks up nested subagent transcripts as subagent lanes", async () => {
    const { file, events, start } = await harness();
    await mkdir(join(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5")), { recursive: true });
    await writeFile(join(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5"), "0-Worker.jsonl"), `${session()}\n`, "utf8");
    await start({ backfillDays: 9999 });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ runId: "019efd8a-f6b8-7000-be44-30cc188e7dc5", agentRole: "subagent", agentId: "0-Worker" });
  });

  it("treats an underscored subagent name as a subagent, not a main session", async () => {
    const { file, events, start } = await harness();
    await mkdir(join(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5")), { recursive: true });
    // An underscore in the agent name must NOT be mistaken for the main "<ts>_<uuid>" file.
    await writeFile(join(file("2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5"), "1-code_reviewer.jsonl"), `${session()}\n`, "utf8");
    await start({ backfillDays: 9999 });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ runId: "019efd8a-f6b8-7000-be44-30cc188e7dc5", agentRole: "subagent", agentId: "1-code_reviewer" });
  });

  it("handles absent session directories as a graceful no-op", async () => {
    const events: TraceEvent[] = [];
    const tailer = await startGjcTailer({ write: async (e) => { events.push(e); } }, { sessionsDir: join(tmpdir(), "missing-gjc-sessions"), pollMs: 20 });
    cleanups.push(async () => tailer.stop());
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
  });

  it("stops an active background drain before it emits the rest of the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "abb-gjc-stop-"));
    const sessionsDir = join(root, "sessions", "-Workspace-project");
    await mkdir(sessionsDir, { recursive: true });
    const file = join(sessionsDir, "2026-06-25T00-00-00-000Z_019efd8a-f6b8-7000-be44-30cc188e7dc5.jsonl");
    await writeFile(file, `${Array.from({ length: 20 }, (_, i) => session(`sess-${i}`)).join("\n")}\n`, "utf8");
    const events: TraceEvent[] = [];
    let releaseWrite!: () => void;
    let markStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const tailer = await startGjcTailer(
      { write: async (event) => {
        events.push(event);
        if (events.length === 1) {
          markStarted();
          await writeGate;
        }
      } },
      { sessionsDir: join(root, "sessions"), pollMs: 20, backfillDays: 9999 }
    );
    cleanups.push(async () => {
      tailer.stop();
      releaseWrite();
      await rm(root, { recursive: true, force: true });
    });

    await writeStarted;
    tailer.stop();
    releaseWrite();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toHaveLength(1);
  });
});
