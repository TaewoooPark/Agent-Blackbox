import { describe, expect, it } from "vitest";
import { computeEfficiencyReport, createTraceEvent, materializeWorkflowGraph, type TraceEventInput } from "@agent-blackbox/core";
import { createMotifcodeNormalizer } from "./normalize.js";
import type { UnknownRecord } from "./types.js";

// Source-shaped fixtures, not a live model dependency: Motifcode 0.4.2's
// packages/journal/src/index.ts and packages/core/src/events.ts.
const at = "2026-10-08T01:00:00.000Z";
const header = {
  t: "header", header: {
    schemaVersion: 2, runId: "motif-run", startedAt: at,
    repository: { cwd: "/Users/test/project" }, model: { id: "motif/motif-3" },
    harness: { version: "0.4.2" }
  }
};

function fixture() {
  let seq = 0;
  const n = createMotifcodeNormalizer({ defaultSessionId: "filename", homeDir: "/Users/test" });
  const line = (rec: UnknownRecord, scope = "root"): UnknownRecord => ({
    v: 2, seq: ++seq, at, runId: "motif-run", scopeId: scope,
    scopeKind: scope === "root" ? "root" : "subagent",
    ...(scope === "root" ? {} : { parentScopeId: "root", agentName: "review" }), record: rec
  });
  const event = (value: UnknownRecord, scope = "root") => line({ t: "event", event: value }, scope);
  const consume = (value: UnknownRecord, scope = "root") => n.consume(event(value, scope));
  const start = (name: string, args: UnknownRecord, scope = "root", id = "call-1") => consume({ type: "tool_start", call: { id, name, arguments: args, repaired: false, validated: true } }, scope);
  const end = (output: string, ok = true, scope = "root", id = "call-1") => consume({ type: "tool_end", id, ok, output, ms: 12 }, scope);
  return { n, line, event, consume, start, end };
}

describe("createMotifcodeNormalizer", () => {
  it("reads v2 identity and only the new task, never checkpoint/history replays", () => {
    const f = fixture();
    expect(f.n.consume(header)[0]).toMatchObject({ host: "motifcode", runId: "motif-run", sessionId: "motif-run", cwd: "/Users/test/project", ts: at, payload: { model: "motif/motif-3" } });
    const prompt = f.n.consume(f.line({ t: "scope_start", task: "Current task", initialMessages: [{ role: "user", content: "Old task" }, { role: "assistant", content: "Old answer" }] }));
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.payload).toEqual({ role: "user", text: "Current task" });
    expect(f.n.consume(f.line({ t: "checkpoint", state: { messages: [{ role: "assistant", content: "Old answer" }] } }))).toEqual([]);
    expect(f.consume({ type: "stream", content: "display-only" })).toEqual([]);
  });

  it("keeps measured prompt/cache counts separate from estimates and credits", () => {
    const f = fixture(); f.n.consume(header);
    const [usage] = f.consume({ type: "usage", contextTokens: 555, kvBytes: 99, promptTokens: 1000, completionTokens: 100, cachedTokens: 800, requestMs: 250, reportedCost: { provider: "infron", unit: "credits", amount: 0.7 } });
    expect(usage?.payload).toMatchObject({ tokens: { input: 1000, output: 100, cache: { read: 800 } }, estimatedContextTokens: 555, requestMs: 250, reportedCost: { provider: "infron", unit: "credits", amount: 0.7 } });
    expect(usage?.payload?.cost).toBeUndefined();
    const [missing] = f.consume({ type: "usage", contextTokens: 800, kvBytes: 99, requestMs: 100 });
    expect(missing?.payload?.tokens).toBeUndefined();
    const [uncached] = f.consume({ type: "usage", promptTokens: 1000, completionTokens: 0 });
    expect(uncached?.payload?.tokens).toEqual({ input: 1000, output: 0 });
    const [zeroCache] = f.consume({ type: "usage", promptTokens: 1000, cachedTokens: 0 });
    expect(zeroCache?.payload?.tokens).toEqual({ input: 1000, cache: { read: 0 } });
    expect(f.consume({ type: "prefix", sharedChars: 9999, totalChars: 10000 })).toEqual([]);
  });

  it("counts repeated identical usage per request and suppresses replayed envelopes", () => {
    const f = fixture(); f.n.consume(header);
    const first = f.event({ type: "usage", promptTokens: 10, completionTokens: 10 });
    expect(f.n.consume(first)).toHaveLength(1);
    expect(f.n.consume(first)).toEqual([]);
    expect(f.consume({ type: "usage", promptTokens: 10, completionTokens: 10 })).toHaveLength(1);
  });

  it("keeps partial token reports from claiming a measured zero-token prompt", () => {
    const f = fixture(); f.n.consume(header);
    const events = f.consume({ type: "usage", contextTokens: 800, completionTokens: 20, cachedTokens: 100, requestMs: 250 });
    expect(events[0]?.payload).toMatchObject({ estimatedContextTokens: 800, reportedCompletionTokens: 20, reportedCachedTokens: 100 });
    expect(events[0]?.payload?.tokens).toBeUndefined();
    const report = computeEfficiencyReport(events.map((event, i) => createTraceEvent(i + 1, event)));
    expect(report.estimated).toBe(true);
    expect(report.metrics.find((metric) => metric.id === "cache-hit")?.display).toBe("n/a");
  });

  it("pairs calls within a scope even when parent and child reuse call IDs", () => {
    const f = fixture(); f.n.consume(header);
    f.start("read", { path: "root.ts" });
    f.n.consume(f.line({ t: "scope_start", task: "Review" }, "sub-review-1"));
    f.start("read", { path: "child.ts" }, "sub-review-1");
    const child = f.end("child", true, "sub-review-1");
    const root = f.end("root");
    expect(child[0]).toMatchObject({ runId: "motif-run", sessionId: "motif-run", agentId: "motif-run:sub-review-1", agentRole: "subagent", agentLabel: "review", kind: "file_read", payload: { path: "child.ts", chars: 5, scopeId: "sub-review-1", parentScopeId: "root" } });
    expect(root[0]).toMatchObject({ kind: "file_read", payload: { path: "root.ts", chars: 4 } });
    expect(root[0]?.agentId).toBeUndefined();
  });

  it("retains primed metadata and pending tools without re-emitting old events", () => {
    const f = fixture();
    f.n.prime(header);
    f.n.prime(f.line({ t: "scope_start", task: "Review" }, "sub-review-1"));
    f.n.prime(f.event({ type: "turn_start", turn: 1 }, "sub-review-1"));
    f.n.prime(f.event({ type: "tool_start", call: { id: "call-1", name: "read", arguments: { path: "old.ts" } } }, "sub-review-1"));
    const result = f.end("data", true, "sub-review-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "file_read", turnId: "motif-run:sub-review-1:turn-1", agentLabel: "review", cwd: "/Users/test/project", payload: { path: "old.ts" } });
  });

  it("maps actual write outcomes, and refuses failed edits", () => {
    const f = fixture(); f.n.consume(header);
    f.start("write", { path: "new.ts", content: "hello" });
    expect(f.end("created new.ts (1 lines, 5 bytes)")[0]).toMatchObject({ kind: "file_created", payload: { chars: 5, path: "new.ts" } });
    f.start("write", { path: "old.ts", content: "world" });
    expect(f.end("replaced old.ts (1 lines, 5 bytes)")[0]?.kind).toBe("file_edit");
    for (const tool of ["write", "read", "apply_patch"]) {
      f.start(tool, { path: "failed.ts", content: "oops", patch: "--- a/failed.ts\n+++ b/failed.ts\n@@ -1 +1 @@\n-a\n+b\n" });
      expect(f.end("Permission denied", false)[0]).toMatchObject({ kind: "tool_result", payload: { success: false } });
    }
  });

  it("records human denials without claiming successful commands or file changes", () => {
    const f = fixture(); f.n.consume(header);
    const output = "The person declined this tool call. Do not retry it as it was; ask what they would prefer, or take a different approach.";
    for (const name of ["write", "apply_patch", "bash", "term", "mcp"]) {
      f.start(name, { path: "untouched.ts", content: "hello", patch: "--- /dev/null\n+++ b/untouched.ts\n@@ -0,0 +1 @@\n+hello\n", command: "git push origin main", keystrokes: "touch untouched.ts\n" });
      // This ok:true is Motifcode's actual execution contract for denial.
      const events = f.end(output, true);
      expect(events.map((event) => event.kind)).toEqual(["permission_replied", "tool_result"]);
      for (const event of events) {
        expect(event.payload).toMatchObject({ success: false, executed: false, decision: "deny", tool: name });
        expect(event.payload?.exitCode).toBeUndefined();
      }
    }
    // A file containing that sentence is still a real file read.
    f.start("read", { path: "instructions.txt" });
    expect(f.end(output)[0]?.kind).toBe("file_read");
  });

  it("parses Motifcode unified diff additions, edits and deletions", () => {
    const f = fixture(); f.n.consume(header);
    f.start("apply_patch", { patch: ["--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+new", "--- a/old.ts", "+++ b/old.ts", "@@ -1 +1 @@", "-old", "+edit", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone", ""].join("\n") });
    const changes = f.end("applied");
    expect(changes.map((e) => [e.kind, e.payload?.path, e.payload?.chars])).toEqual([["file_created", "new.ts", 3], ["file_edit", "old.ts", 7], ["file_deleted", "gone.ts", 4]]);
  });

  it("redacts summaries, paths, messages, labels and diagnostics", () => {
    const f = fixture(); f.n.consume(header);
    f.start("bash", { command: "echo /Users/test/private; API_KEY=super-secret-value" });
    const bash = f.end("output")[0];
    expect(bash?.summary).not.toContain("/Users/test");
    expect(bash?.summary).not.toContain("super-secret-value");
    expect(bash?.redaction?.rulesApplied?.length).toBeGreaterThan(0);
    const [notice] = f.consume({ type: "notice", level: "warn", text: "Authorization: Bearer super-secret-value" });
    expect(JSON.stringify(notice?.payload)).not.toContain("super-secret-value");
    const child = f.line({ t: "scope_start", task: "Review /Users/test/private" }, "sub-review-1");
    child.agentName = "/Users/test/private";
    expect(f.n.consume(child)[0]?.agentLabel).not.toContain("/Users/test");
  });

  it("does not invent failing bash exit codes and preserves MCP context", () => {
    const f = fixture(); f.n.consume(header);
    f.start("bash", { command: "npm test" });
    const [failed] = f.end("failed tests", false);
    expect(failed?.payload).toMatchObject({ success: false, command: "npm test" });
    expect(failed?.payload?.exitCode).toBeUndefined();
    f.start("bash", { command: "exit 9" });
    expect(f.end("(exit 9)", false)[0]?.payload?.exitCode).toBe(9);
    f.start("mcp", { server: "docs", method: "search", args: { q: "topic" } });
    expect(f.end("results")[0]).toMatchObject({ kind: "tool_result", payload: { tool: "mcp", server: "docs", method: "search" } });
  });

  it("recognizes leading git commands without treating quoted words as operations", () => {
    const f = fixture(); f.n.consume(header);
    for (const command of ["echo 'git push'", "grep 'git commit' README.md", "printf 'git status'", "git add . && git commit -m changed", "git push || true", "git status | cat"]) {
      f.start("bash", { command });
      expect(f.end("output")[0]?.kind).toBe("bash");
    }
    for (const [command, kind] of [["git push origin main", "git_push"], ["git commit -m changed", "git_commit"], ["git status --short", "git_status"]]) {
      f.start("bash", { command });
      expect(f.end("output")[0]?.kind).toBe(kind);
    }
  });

  it("keeps failed children separate and deduplicates event + scope endings", () => {
    const f = fixture();
    const events: TraceEventInput[] = [...f.n.consume(header), ...f.n.consume(f.line({ t: "scope_start", task: "Review" }, "sub-review-1")), ...f.consume({ type: "turn_start", turn: 1 }), ...f.consume({ type: "turn_start", turn: 1 }, "sub-review-1")];
    const end = f.consume({ type: "session_end", reason: "transport_error" }, "sub-review-1");
    expect(end.map((e) => e.kind)).toEqual(["turn_end", "agent_end"]);
    expect(end.at(-1)?.payload).toMatchObject({ reason: "transport_error", success: false });
    expect(f.n.consume(f.line({ t: "scope_end", result: { endReason: "transport_error", turns: 1 } }, "sub-review-1"))).toEqual([]);
    expect(end.some((e) => e.kind === "session_error")).toBe(false);
    const graph = materializeWorkflowGraph([...events, ...end].map((event, i) => createTraceEvent(i + 1, event)));
    expect(graph.nodes.find((node) => node.type === "SESSION")?.status).toBe("ACTIVE");
    expect(graph.nodes.find((node) => node.type === "AGENT")?.status).toBe("FAILED");
    const rootEnd = f.consume({ type: "session_end", reason: "done", summary: "Finished" });
    expect(rootEnd.at(-1)?.kind).toBe("session_idle");
    expect(f.n.consume(f.line({ t: "scope_end", result: { endReason: "done", summary: "Finished", turns: 1 } }))).toEqual([]);
  });

  it("reports offline transport failure and emits completion prose only once", () => {
    const f = fixture(); f.n.consume(header);
    f.consume({ type: "turn_start", turn: 1 });
    const failure = f.consume({ type: "session_end", reason: "transport_error" });
    expect(failure.at(-1)).toMatchObject({ kind: "session_error", payload: { reason: "transport_error" } });
    const second = fixture(); second.n.consume(header);
    second.consume({ type: "turn_start", turn: 1 });
    second.consume({ type: "content_delta", text: "Finished" });
    expect(second.consume({ type: "session_end", reason: "done", summary: "Finished" }).some((e) => e.kind === "message")).toBe(false);
  });

  it("ignores malformed and future records without breaking following valid events", () => {
    const f = fixture(); f.n.consume(header);
    for (const bad of [{ t: "header", header: { schemaVersion: 3, runId: "other" } }, { v: 3, seq: 1 }, { v: 2, seq: -1 }, { v: 2, seq: 1, runId: "different", scopeId: "root", scopeKind: "root" }]) expect(f.n.consume(bad)).toEqual([]);
    expect(f.consume({ type: "new_future_event", text: "ignore" })).toEqual([]);
    expect(f.consume({ type: "content_delta", text: "still working" })[0]?.payload).toMatchObject({ role: "assistant", chars: 13 });
  });

  it("stores assistant content, reasoning, plans and compaction as sizes", () => {
    const f = fixture(); f.n.consume(header);
    for (const event of [
      { type: "content_delta", text: "private content" },
      { type: "reasoning_delta", text: "private reasoning" },
      { type: "plan", plan: "private plan", analysis: "private analysis" },
      { type: "compaction", beforeTokens: 2000, summary: "private summary" },
      { type: "parse_failure", kind: "unrecoverable", sample: "private tool response" }
    ]) {
      const [output] = f.consume(event);
      expect(JSON.stringify(output?.payload)).not.toContain("private");
    }
    expect(f.consume({ type: "parse_failure", kind: "unrecoverable", sample: "private tool response" })[0]?.payload).toEqual({ event: "parse_failure", kind: "unrecoverable", sampleChars: 21 });
  });

  it("captures the remaining recorded lifecycle, skill, terminal and recovery events", () => {
    const f = fixture(); f.n.consume(header);
    expect(f.n.consume(f.line({ t: "resume", fromSeq: 42, previousRunId: "earlier-run" }))[0]).toMatchObject({ kind: "host_event", payload: { event: "resume", previousRunId: "earlier-run" } });
    expect(f.consume({ type: "session_start", model: "motif/new-model", endpoint: "https://api-cbt.morphfactory.io", channel: "native", tools: [], toolsHash: "tools" })[0]).toMatchObject({ kind: "model_switched", payload: { model: "motif/new-model" } });
    f.start("skill", { name: "review", arguments: "src/" });
    expect(f.end("private skill instructions")[0]).toMatchObject({ kind: "command_run", payload: { command: "review", outputChars: 26 } });
    f.start("term", { keystrokes: "printf ready\n", duration_s: 0.1 });
    expect(f.end("ready")[0]).toMatchObject({ kind: "tool_result", payload: { tool: "term", success: true, outputChars: 5 } });
    // A persistent terminal reporting alive is not evidence that the command
    // finished, so it does not produce a bash event with a fabricated exit code.
    for (const event of [
      { type: "repair", kind: "tool_failure", reason: "tool failure", attempt: 1, max: 2 },
      { type: "channel_downgrade", from: "native", to: "object", reason: "repeated parse failures" },
      { type: "hook", event: "OnRepair", label: "check", ok: true },
      { type: "queue", agent: "review", state: "running" },
      { type: "loop_detected", signature: "read:file", repeats: 3 }
    ]) {
      const [output] = f.consume(event);
      expect(output?.kind).toBe("host_event");
      expect(output?.payload?.type).toBe(event.type);
    }
    expect(f.consume({ type: "compaction", beforeTokens: 240000, summaryChars: 7, summary: "summary" })[0]).toMatchObject({ kind: "context_compacted", payload: { beforeTokens: 240000, summaryChars: 7 } });
  });

  it("treats header-shaped hunk content as edits to the existing file", () => {
    const f = fixture(); f.n.consume(header);
    f.start("apply_patch", { patch: [
      "--- a/real.txt", "+++ b/real.txt", "@@ -1 +1 @@",
      "--- not-a-path", "+++ fake.txt",
      "@@ -3 +3 @@", "-old", "+new", ""
    ].join("\n") });
    const changes = f.end("applied");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "file_edit", payload: { path: "real.txt", chars: "-- not-a-path".length + "++ fake.txt".length + 6 } });
  });

  it("keeps identically named child scopes in separate runs distinct in the graph", () => {
    const outputs: TraceEventInput[] = [];
    for (const runId of ["run-one", "run-two"]) {
      const n = createMotifcodeNormalizer({ defaultSessionId: runId });
      outputs.push(...n.consume({ ...header, header: { ...header.header, runId } }));
      const child = { v: 2, at, runId, scopeId: "sub-explorer-001", scopeKind: "subagent", parentScopeId: "root", agentName: "explorer" };
      outputs.push(...n.consume({ ...child, seq: 1, record: { t: "scope_start", task: "Inspect" } }));
      outputs.push(...n.consume({ ...child, seq: 2, record: { t: "scope_end", result: { endReason: runId === "run-one" ? "transport_error" : "done" } } }));
    }
    const graph = materializeWorkflowGraph(outputs.map((event, index) => createTraceEvent(index + 1, event)));
    const agents = graph.nodes.filter((node) => node.type === "AGENT");
    expect(agents).toHaveLength(2);
    expect(agents.find((node) => node.data.agentId === "run-one:sub-explorer-001")?.status).toBe("FAILED");
    expect(agents.find((node) => node.data.agentId === "run-two:sub-explorer-001")?.status).toBe("SUCCEEDED");
    for (const event of outputs.filter((event) => event.kind === "agent_start" || event.kind === "agent_end")) {
      expect(event.payload?.agentId).toBe(event.agentId);
      expect(event.payload?.parentScopeId).toBe("root");
    }
  });

  it("carries namespaced parent identity on child events after priming", () => {
    const f = fixture();
    f.n.prime(header);
    f.n.prime(f.line({ t: "scope_start", task: "Parent" }, "parent"));
    const start = f.line({ t: "scope_start", task: "Nested child" }, "nested");
    start.parentScopeId = "parent";
    f.n.prime(start);
    const next = f.event({ type: "content_delta", text: "Continued" }, "nested");
    next.parentScopeId = "parent";
    expect(f.n.consume(next)[0]).toMatchObject({ agentId: "motif-run:nested", payload: { scopeId: "nested", parentScopeId: "motif-run:parent" } });
  });
});
