import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent } from "@agent-blackbox/core";
import { startClaudeCodeTailer } from "./tailer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const assistant = (i: number, sessionId = "sess1") =>
  JSON.stringify({ type: "assistant", sessionId, timestamp: `2026-06-21T00:00:0${i}.000Z`, message: { usage: { input_tokens: i * 100 }, content: [] } });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "abb-tail-"));
  const projectsDir = join(root, "projects");
  await mkdir(join(projectsDir, "p"), { recursive: true });
  const events: TraceEvent[] = [];
  const file = (name: string) => join(projectsDir, "p", name);
  const start = async (opts: { backfillDays?: number } = {}) => {
    const tailer = await startClaudeCodeTailer({ write: async (e) => { events.push(e); } }, { projectsDir, pollMs: 20, ...opts });
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

describe("claude code tailer", () => {
  it("skips a malformed line, buffers a partial last line, and emits it once completed", async () => {
    const { file, events, start } = await harness();
    // valid, MALFORMED, valid, then a partial last line with no trailing newline.
    await writeFile(file("sess1.jsonl"), `${assistant(1)}\n{ not json,,\n${assistant(2)}\n{"type":"assistant","sessionId":"sess1","message":{"usage":{"input_tokens":900}`, "utf8");
    await start({ backfillDays: 9999 }); // read the pre-written fixture from the top
    await waitFor(() => events.length === 2); // 2 valid; malformed skipped; partial buffered
    await appendFile(file("sess1.jsonl"), "}}\n"); // complete the buffered line
    await waitFor(() => events.length === 3);
    expect(events.every((e) => e.host === "claude-code")).toBe(true);
  });

  it("picks up a newly created file and ignores non-.jsonl files", async () => {
    const { file, events, start } = await harness();
    await start();
    await writeFile(file("notes.txt"), "ignore me\n", "utf8");
    await writeFile(file("sess1.jsonl"), `${assistant(1)}\n`, "utf8");
    await waitFor(() => events.length === 1);
    // Give a non-jsonl file a chance to (wrongly) be read — it must not be.
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toHaveLength(1);
  });

  it("resets and re-reads when a file is truncated/rotated", async () => {
    const { file, events, start } = await harness();
    await writeFile(file("sess1.jsonl"), `${assistant(1)}\n${assistant(2)}\n`, "utf8");
    await start({ backfillDays: 9999 });
    await waitFor(() => events.length === 2);
    await writeFile(file("sess1.jsonl"), `${assistant(5)}\n`, "utf8"); // shorter → offset > size
    await waitFor(() => events.length === 3);
  });

  it("nests an agent-<id>.jsonl under its parent session as a subagent lane", async () => {
    const { file, events, start } = await harness();
    await writeFile(file("agent-abc123.jsonl"), `${assistant(1, "parent-session")}\n`, "utf8");
    await start({ backfillDays: 9999 });
    await waitFor(() => events.length >= 1);
    const e = events[0];
    expect(e?.runId).toBe("parent-session"); // inherits the parent session as the run
    expect(e?.agentId).toBe("abc123");
    expect(e?.agentRole).toBe("subagent");
  });

  it("survives an empty file without crashing", async () => {
    const { file, events, start } = await harness();
    await writeFile(file("empty.jsonl"), "", "utf8");
    await writeFile(file("sess1.jsonl"), `${assistant(1)}\n`, "utf8");
    await start({ backfillDays: 9999 });
    await waitFor(() => events.length === 1);
  });

  it("tails from the current end by default — ignores pre-existing history, captures only new lines", async () => {
    const { file, events, start } = await harness();
    // A big pre-existing transcript (the blow-up scenario: a huge ~/.claude backlog).
    const history = Array.from({ length: 50 }, (_, i) => assistant((i % 9) + 1)).join("\n");
    await writeFile(file("sess1.jsonl"), `${history}\n`, "utf8");
    await start(); // default: no backfill
    // Give the poller a few ticks; the 50 historical lines must NOT be ingested.
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toHaveLength(0);
    // A line appended after start IS captured.
    await appendFile(file("sess1.jsonl"), `${assistant(2)}\n`, "utf8");
    await waitFor(() => events.length === 1);
    expect(events[0]?.host).toBe("claude-code");
  });
});
