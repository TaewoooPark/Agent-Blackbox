import { evaluateRulePack, type TraceEvent } from "@agent-blackbox/core";
import { startMotifcodeTailer } from "@agent-blackbox/motifcode-adapter";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { loadTraceEvents, startTraceDaemon, type TraceSnapshot } from "./server.js";

it("carries Motifcode journals through live capture, replay, analysis, and reversible optimization", async () => {
  const root = await mkdtemp(join(tmpdir(), "abb-motifcode-product-"));
  const project = join(root, "project");
  const sessionsDir = join(project, ".motif", "sessions");
  const journal = join(sessionsDir, "product-run.jsonl");
  const agentsMd = join(project, "AGENTS.md");
  const originalGuidance = "# Project guidance\n\nKeep the public API stable.\n";
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(join(project, ".agent-blackbox"));
  await writeFile(agentsMd, originalGuidance);
  await writeFile(join(project, ".agent-blackbox", "rules.json"), JSON.stringify({
    rules: [{ id: "read-once", type: "max-reads", pattern: "calc\\.ts", limit: 1 }]
  }));

  let seq = 0;
  const record = (record: Record<string, unknown>, child = false) => ({
    v: 2, seq: ++seq, at: new Date(Date.UTC(2026, 9, 15, 0, 0, seq)).toISOString(),
    runId: "motif-product", scopeId: child ? "review" : "root", scopeKind: child ? "subagent" : "root",
    ...(child ? { parentScopeId: "root", agentName: "Reviewer" } : {}), record
  });
  const event = (event: Record<string, unknown>, child = false) => record({ t: "event", event }, child);
  const tool = (id: string, name: string, args: Record<string, unknown>, output: string, ok = true, child = false) => [
    event({ type: "tool_start", call: { id, name, arguments: args } }, child),
    event({ type: "tool_end", id, ok, output, ms: 5 }, child)
  ];
  const initial = [
    { t: "header", header: { schemaVersion: 2, runId: "motif-product", startedAt: "2026-10-15T00:00:00.000Z", repository: { cwd: project }, model: { id: "fixture/model" } } },
    record({ t: "scope_start", task: "Fix calculation and run tests." }),
    event({ type: "turn_start", turn: 1 }),
    ...tool("read1", "read", { path: "src/calc.ts" }, "PRIVATE_SOURCE_CONTENT".repeat(4000)),
    ...tool("read2", "read", { path: "src/calc.ts" }, "PRIVATE_SOURCE_CONTENT".repeat(4000)),
    ...tool("write1", "write", { path: "src/calc.ts", content: "fixed calculation" }, "replaced src/calc.ts"),
    ...tool("test1", "bash", { command: "npm test" }, "one failure", false),
    ...tool("test2", "bash", { command: "npm test" }, "all tests passed"),
    event({ type: "usage", promptTokens: 20_000, completionTokens: 100, cachedTokens: 19_000, contextTokens: 22_000 }),
    record({ t: "scope_start", task: "Review the calculation fix" }, true),
    event({ type: "turn_start", turn: 1 }, true),
    ...tool("child-read", "read", { path: "src/review.ts" }, "reviewed source", true, true),
    record({ t: "scope_end", result: { reason: "done", summary: "Reviewed" } }, true)
  ];
  await writeFile(journal, initial.map((line) => JSON.stringify(line)).join("\n") + "\n");

  // Keep the daemon store separate to verify cwd routes rules and memory back
  // to the actual Motifcode project. Suggestions are deterministic: no providers.
  const daemon = await startTraceDaemon({ projectDir: join(root, "store"), port: 0, suggest: { mode: "off" }, recordHosts: ["motifcode"] });
  let tailer: Awaited<ReturnType<typeof startMotifcodeTailer>> | undefined;
  let socket: WebSocket | undefined;
  const base = `http://127.0.0.1:${daemon.port}`;
  const get = async <T>(path: string, method = "GET"): Promise<T> => {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: T };
    expect(body.ok).toBe(true);
    return body.data;
  };

  try {
    tailer = await startMotifcodeTailer({ write: daemon.ingest }, { projectDir: project, backfillDays: 1, pollMs: 10 });
    await vi.waitFor(async () => expect((await loadTraceEvents(daemon.eventsFile)).at(-1)?.kind).toBe("agent_end"));
    const frames: { type: string; events?: TraceEvent[]; data?: TraceSnapshot }[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/stream`);
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    await vi.waitFor(() => expect(frames[0]?.type).toBe("snapshot"));
    expect(frames[0]?.data?.events.every((e) => e.host === "motifcode")).toBe(true);

    await appendFile(journal, JSON.stringify(event({ type: "session_end", reason: "done", summary: "Fixed and tested" })) + "\n");
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === "append" && frame.events?.some((e) => e.kind === "session_idle"))).toBe(true));

    const snapshot = await get<TraceSnapshot>("/snapshot");
    expect(snapshot.graph?.nodes).toContainEqual(expect.objectContaining({ type: "AGENT", status: "SUCCEEDED", data: expect.objectContaining({ agentName: "Reviewer" }) }));
    expect(snapshot.graph?.nodes).toContainEqual(expect.objectContaining({ type: "COMMAND", status: "FAILED", data: expect.objectContaining({ command: "npm test" }) }));
    expect(snapshot.efficiency.estimated).toBe(false);
    expect(snapshot.efficiency.metrics.find((metric) => metric.id === "cache-hit")?.value).toBe(0.95);
    expect(snapshot.effectiveness.signals).toContainEqual(expect.objectContaining({ id: "verify", tone: "good" }));
    expect(snapshot.baselines).toContainEqual(expect.objectContaining({ runId: "motif-product", project: basename(project) }));
    expect(evaluateRulePack(snapshot.events, snapshot.rulePacks[basename(project)]!)).toContainEqual(expect.objectContaining({ ruleId: "read-once" }));

    const durable = await get<TraceEvent[]>("/events");
    expect(durable).toEqual(snapshot.events);
    expect(await readFile(daemon.eventsFile, "utf8")).not.toContain("PRIVATE_SOURCE_CONTENT");
    const firstRead = durable.find((e) => e.kind === "file_read")!;
    const replay = await get<TraceSnapshot>(`/snapshot?seq=${firstRead.seq}`);
    expect(replay.replay.mode).toBe("seq");
    expect(replay.graph?.appliedEventIds).toHaveLength(firstRead.seq);
    expect(replay.graph?.nodes.some((node) => node.type === "COMMAND")).toBe(false);

    const handoff = await get<{ markdown: string }>("/handoff");
    expect(handoff.markdown).toContain("Fix calculation and run tests.");
    expect(handoff.markdown).toContain("## Failed Attempts");
    expect(handoff.markdown).toContain("npm test [FAILED]");
    const suggestions = await get<{ provider: string; suggestions: { metricId: string }[] }>("/suggest");
    expect(suggestions.provider).toBe("deterministic");
    expect(suggestions.suggestions).toContainEqual(expect.objectContaining({ metricId: "redundant-reads" }));

    const preview = await get<{ agentsMdPath: string; block: string; applied: boolean }>("/optimize?runId=motif-product");
    expect(preview.agentsMdPath).toBe(agentsMd);
    expect(preview.applied).toBe(false);
    expect(preview.block).toContain("npm test");
    expect(await readFile(agentsMd, "utf8")).toBe(originalGuidance);
    await get("/optimize/apply?runId=motif-product", "POST");
    expect(await readFile(agentsMd, "utf8")).toContain("agent-blackbox:efficiency:start");
    await get("/optimize/revert?runId=motif-product", "POST");
    expect(await readFile(agentsMd, "utf8")).toBe(originalGuidance);
  } finally {
    tailer?.stop();
    socket?.terminate();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
