import type { TraceEvent } from "@agent-blackbox/core";
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMotifcodeSessionsDir, startMotifcodeTailer } from "./tailer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const pause = (ms = 60) => new Promise<void>((done) => setTimeout(done, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await pause(10);
  }
  throw new Error("timed out waiting for Motifcode tailer");
}

const at = "2026-10-08T03:00:00.000Z";
const header = (runId = "run-1", cwd = "/project") => ({
  t: "header",
  header: { schemaVersion: 2, runId, startedAt: at, repository: { cwd }, model: { id: "motif-model" } }
});
const record = (seq: number, value: Record<string, unknown>, runId = "run-1", child = false) => ({
  v: 2, seq, at, runId,
  scopeId: child ? "reviewer-scope" : "root-scope",
  scopeKind: child ? "subagent" : "root",
  ...(child ? { parentScopeId: "root-scope", agentName: "reviewer" } : {}),
  record: value
});
// User task text is persisted; assistant deltas deliberately retain only counts.
const content = (seq: number, text: string, runId = "run-1") => record(seq, { t: "scope_start", initialMessages: [], task: text }, runId);
const lines = (...values: unknown[]) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
const hasText = (event: TraceEvent, text: string) => event.kind === "message" && JSON.stringify(event).includes(text);

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abb-motifcode-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function stopAfter(tailer: { stop: () => void }): void {
  // Stop the background reader before its temporary directory is removed.
  cleanups.unshift(async () => { tailer.stop(); });
}

describe("Motifcode journal tailer", () => {
  it("defaults to the current project's .motif/sessions directory", () => {
    expect(defaultMotifcodeSessionsDir()).toBe(resolve(process.cwd(), ".motif", "sessions"));
    expect(defaultMotifcodeSessionsDir("relative-project")).toBe(resolve("relative-project", ".motif", "sessions"));
  });

  it("starts before Motifcode has created its directory and discovers later journals", async () => {
    const projectDir = await temporaryProject();
    const events: TraceEvent[] = [];
    const tailer = await startMotifcodeTailer({ write: async (event) => { events.push(event); } }, { projectDir, pollMs: 10 });
    stopAfter(tailer);
    expect(tailer.sessionsDir).toBe(join(projectDir, ".motif", "sessions"));
    await mkdir(tailer.sessionsDir, { recursive: true });
    await writeFile(join(tailer.sessionsDir, "run-1.jsonl"), lines(header(), content(1, "model connection restored")));
    await waitFor(() => events.some((event) => hasText(event, "model connection restored")));
    expect(events.find((event) => event.kind === "session_created")).toMatchObject({ host: "motifcode", runId: "run-1", cwd: "/project" });
  });

  it("primes old scope, turn, and tool metadata without emitting history", async () => {
    const projectDir = await temporaryProject();
    const sessionsDir = join(projectDir, "custom-journals");
    await mkdir(sessionsDir);
    const file = join(sessionsDir, "run-1.jsonl");
    await writeFile(file, lines(
      header("run-1", projectDir),
      record(1, { t: "scope_start", initialMessages: [], task: "old root task" }),
      record(2, { t: "scope_start", initialMessages: [], task: "old reviewer task" }, "run-1", true),
      record(3, { t: "event", event: { type: "turn_start", turn: 1 } }, "run-1", true),
      record(4, { t: "event", event: { type: "tool_start", call: { id: "read-1", name: "read_file", arguments: { path: "src/index.ts" }, repaired: false, validated: true } } }, "run-1", true)
    ));
    const events: TraceEvent[] = [];
    const tailer = await startMotifcodeTailer({ write: async (event) => { events.push(event); } }, { sessionsDir, projectDir, pollMs: 10 });
    stopAfter(tailer);
    await appendFile(file, lines(record(5, { t: "event", event: { type: "tool_end", id: "read-1", ok: true, output: "export const ready = true;", ms: 2 } }, "run-1", true)));
    await waitFor(() => events.some((event) => event.kind === "tool_result"));
    const result = events.find((event) => event.kind === "tool_result");
    expect(result).toMatchObject({ host: "motifcode", runId: "run-1", sessionId: "run-1", cwd: projectDir, agentId: "run-1:reviewer-scope", agentRole: "subagent", agentLabel: "reviewer", payload: { parentScopeId: "root" } });
    expect(result?.turnId).toBeTruthy();
    expect(JSON.stringify(result)).toContain("read_file");
    expect(events.some((event) => ["session_created", "tool_call", "agent_start", "subagent_spawned", "message"].includes(event.kind))).toBe(false);
  });

  it("backfills recent files, skips old history and malformed records, and deduplicates sequences", async () => {
    const sessionsDir = await temporaryProject();
    const old = join(sessionsDir, "old.jsonl");
    await writeFile(old, lines(header("old"), content(1, "old history", "old")));
    const oldTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(old, oldTime, oldTime);
    await writeFile(join(sessionsDir, "recent.jsonl"), `${lines(header(), content(1, "recent history"))}{broken json\nnull\n[]\n42\n${lines(content(1, "recent history"), content(2, "after malformed"))}`);
    const events: TraceEvent[] = [];
    const tailer = await startMotifcodeTailer({ write: async (event) => { events.push(event); } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => events.some((event) => hasText(event, "after malformed")));
    await appendFile(old, lines(content(2, "old run resumed", "old")));
    await waitFor(() => events.some((event) => hasText(event, "old run resumed")));
    expect(events.some((event) => hasText(event, "old history"))).toBe(false);
    expect(events.filter((event) => hasText(event, "recent history"))).toHaveLength(1);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it("keeps a partial record and split UTF-8 character across the initial EOF", async () => {
    const sessionsDir = await temporaryProject();
    const file = join(sessionsDir, "run-1.jsonl");
    const complete = Buffer.from(lines(content(1, "restored 🙂 한국어")));
    const split = complete.indexOf(Buffer.from("🙂")) + 1;
    await writeFile(file, Buffer.concat([Buffer.from(lines(header())), complete.subarray(0, split)]));
    const events: TraceEvent[] = [];
    const tailer = await startMotifcodeTailer({ write: async (event) => { events.push(event); } }, { sessionsDir, pollMs: 10 });
    stopAfter(tailer);
    await pause();
    expect(events).toHaveLength(0);
    await appendFile(file, complete.subarray(split));
    await waitFor(() => events.some((event) => hasText(event, "restored 🙂 한국어")));
    expect(events).toHaveLength(1);
  });

  it("preserves UTF-8 across a large backfill chunk boundary", async () => {
    const sessionsDir = await temporaryProject();
    const render = (padding: number) => lines({ padding: "x".repeat(padding), ...header("run-🙂") });
    const probe = render(0);
    const markerOffset = Buffer.byteLength(probe.slice(0, probe.indexOf("🙂")));
    const text = render((1 << 20) - 1 - markerOffset);
    expect(Buffer.byteLength(text.slice(0, text.indexOf("🙂")))).toBe((1 << 20) - 1);
    await writeFile(join(sessionsDir, "run.jsonl"), text);
    const events: TraceEvent[] = [];
    const tailer = await startMotifcodeTailer({ write: async (event) => { events.push(event); } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => events.some((event) => event.kind === "session_created"));
    expect(events[0]?.runId).toBe("run-🙂");
  });

  it("does not replay appends when live polling overlaps a slow background backfill", async () => {
    const sessionsDir = await temporaryProject();
    await writeFile(join(sessionsDir, "a.jsonl"), lines(header("a"), content(1, "a history", "a")));
    const second = join(sessionsDir, "b.jsonl");
    await writeFile(second, lines(header("b"), content(1, "b history", "b")));
    const events: TraceEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    cleanups.unshift(async () => { release(); });
    const tailer = await startMotifcodeTailer({ write: async (event) => {
      events.push(event);
      if (events.length === 1) await gate;
    } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => events.length === 1);
    await appendFile(second, lines(content(2, "b live append", "b")));
    await pause();
    release();
    await waitFor(() => events.some((event) => hasText(event, "b live append")));
    await pause();
    expect(events.filter((event) => hasText(event, "b live append"))).toHaveLength(1);
    expect(events.filter((event) => hasText(event, "b history"))).toHaveLength(1);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });

  it("handles replacement and truncation without duplicating previous records", async () => {
    const sessionsDir = await temporaryProject();
    const file = join(sessionsDir, "run-1.jsonl");
    const existing = lines(header(), content(1, "before replacement"));
    await writeFile(file, existing);
    const events: TraceEvent[] = [];
    const tailer = await startMotifcodeTailer({ write: async (event) => { events.push(event); } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => events.some((event) => hasText(event, "before replacement")));
    const replacement = join(sessionsDir, "replacement.tmp");
    await writeFile(replacement, existing + lines(content(2, "after replacement")));
    await rename(replacement, file);
    await waitFor(() => events.some((event) => hasText(event, "after replacement")));
    await writeFile(file, lines(content(3, "after truncation")));
    await waitFor(() => events.some((event) => hasText(event, "after truncation")));
    expect(events.filter((event) => hasText(event, "before replacement"))).toHaveLength(1);
    expect(events.filter((event) => event.kind === "session_created")).toHaveLength(1);
  });

  it("stops an active background drain before further events reach the sink", async () => {
    const sessionsDir = await temporaryProject();
    await writeFile(join(sessionsDir, "run-1.jsonl"), lines(header(), ...Array.from({ length: 20 }, (_, index) => content(index + 1, `message ${index}`))));
    const events: TraceEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    cleanups.unshift(async () => { release(); });
    const tailer = await startMotifcodeTailer({ write: async (event) => {
      events.push(event);
      if (events.length === 1) await gate;
    } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => events.length === 1);
    tailer.stop();
    release();
    await pause();
    await appendFile(join(sessionsDir, "run-1.jsonl"), lines(content(21, "after stop")));
    await pause();
    expect(events).toHaveLength(1);
  });

  it("preserves event IDs across recorder restart and a full journal backfill", async () => {
    const sessionsDir = await temporaryProject();
    const file = join(sessionsDir, "run-1.jsonl");
    const events: TraceEvent[] = [];
    const sink = { write: async (event: TraceEvent) => { events.push(event); } };
    const first = await startMotifcodeTailer(sink, { sessionsDir, pollMs: 10 });
    stopAfter(first);
    await writeFile(file, lines(header(), content(1, "before restart")));
    await waitFor(() => events.some((event) => hasText(event, "before restart")));
    first.stop();

    const restarted = await startMotifcodeTailer(sink, { sessionsDir, pollMs: 10 });
    stopAfter(restarted);
    await appendFile(file, lines(content(2, "after restart")));
    await waitFor(() => events.some((event) => hasText(event, "after restart")));
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);

    const replayed: TraceEvent[] = [];
    const backfill = await startMotifcodeTailer({ write: async (event) => { replayed.push(event); } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(backfill);
    await waitFor(() => replayed.some((event) => hasText(event, "after restart")));
    expect(replayed.map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it("retries the same pending event and retains later records and appends in order", async () => {
    const sessionsDir = await temporaryProject();
    const file = join(sessionsDir, "run-1.jsonl");
    const delivered: TraceEvent[] = [];
    const attempts: TraceEvent[] = [];
    let failures = 0;
    const tailer = await startMotifcodeTailer({ write: async (event) => {
      attempts.push(event);
      // Fail halfway through the two events produced by a child scope_start.
      if (event.kind === "message" && event.agentRole === "subagent" && failures < 2) {
        failures++;
        throw new Error("temporary sink outage");
      }
      delivered.push(event);
    } }, { sessionsDir, pollMs: 20 });
    stopAfter(tailer);
    await writeFile(file, lines(
      header(), content(1, "before child"),
      record(2, { t: "scope_start", initialMessages: [], task: "queued child" }, "run-1", true),
      content(3, "after child")
    ));
    await waitFor(() => failures > 0);
    await appendFile(file, lines(content(4, "while sink recovering")));
    await waitFor(() => delivered.some((event) => hasText(event, "while sink recovering")));
    expect(delivered.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(delivered.filter((event) => event.kind === "message").map((event) => event.payload.text))
      .toEqual(["before child", "queued child", "after child", "while sink recovering"]);
    const retried = attempts.filter((event) => event.seq === 4);
    expect(retried).toHaveLength(3);
    expect(retried.every((event) => event === retried[0])).toBe(true);
  });

  it("delivers already-read pending records even if the journal disappears", async () => {
    const sessionsDir = await temporaryProject();
    const file = join(sessionsDir, "run-1.jsonl");
    await writeFile(file, lines(header(), content(1, "retained first"), content(2, "retained second")));
    const delivered: TraceEvent[] = [];
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    cleanups.unshift(async () => { release(); });
    const tailer = await startMotifcodeTailer({ write: async (event) => {
      if (!started) {
        started = true;
        await gate;
        throw new Error("temporary sink outage");
      }
      delivered.push(event);
    } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => started);
    await rm(file);
    release();
    await waitFor(() => delivered.some((event) => hasText(event, "retained second")));
    expect(delivered.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("stops retrying a rejected pending event after stop", async () => {
    const sessionsDir = await temporaryProject();
    await writeFile(join(sessionsDir, "run-1.jsonl"), lines(header(), content(1, "pending")));
    let attempts = 0;
    const tailer = await startMotifcodeTailer({ write: async () => {
      attempts++;
      throw new Error("sink unavailable");
    } }, { sessionsDir, pollMs: 10, backfillDays: 1 });
    stopAfter(tailer);
    await waitFor(() => attempts > 0);
    tailer.stop();
    const stoppedAt = attempts;
    await pause();
    expect(attempts).toBe(stoppedAt);
  });
});
