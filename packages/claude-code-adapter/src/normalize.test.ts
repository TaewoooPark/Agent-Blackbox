import { describe, expect, it } from "vitest";
import { createClaudeNormalizer } from "./normalize.js";
import type { ClaudeNormalizerContext } from "./types.js";

const ctx = (): ClaudeNormalizerContext => ({ runId: "S1", defaultSessionId: "S1" });

const assistant = (content: unknown[], usage?: Record<string, number>, model = "claude-opus-4-8") => ({
  type: "assistant",
  sessionId: "S1",
  cwd: "/proj",
  timestamp: "2026-06-21T00:00:00.000Z",
  message: { model, ...(usage ? { usage } : {}), content }
});

const userResult = (toolUseId: string, content: unknown, toolUseResult: unknown, isError = false) => ({
  type: "user",
  sessionId: "S1",
  cwd: "/proj",
  timestamp: "2026-06-21T00:00:01.000Z",
  toolUseResult,
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] }
});

describe("createClaudeNormalizer", () => {
  it("emits a real-token snapshot summing uncached + cache read + cache write", () => {
    const n = createClaudeNormalizer(ctx());
    const { events } = n.consume(
      assistant([{ type: "thinking", thinking: "…" }], {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 50
      })
    );
    const msg = events.find((e) => e.kind === "message");
    expect(msg).toBeDefined();
    expect(msg?.host).toBe("claude-code");
    expect(msg?.runId).toBe("S1");
    const payload = msg?.payload as { tokens?: { input: number; output: number; cache: { read: number; write: number } } };
    expect(payload.tokens?.input).toBe(650);
    expect(payload.tokens?.output).toBe(20);
    expect(payload.tokens?.cache).toEqual({ read: 500, write: 50 });
  });

  it("pairs a Read tool_use with its result into file_read{path,chars}", () => {
    const n = createClaudeNormalizer(ctx());
    n.consume(assistant([{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/proj/a.ts" } }]));
    const { events } = n.consume(
      userResult("tu1", "abcde", { type: "text", file: { filePath: "/proj/a.ts", content: "abcde", numLines: 1 } })
    );
    const read = events.find((e) => e.kind === "file_read");
    expect(read?.payload).toMatchObject({ path: "/proj/a.ts", chars: 5 });
  });

  it("maps Bash with is_error to bash{command,exitCode:1,outputChars}", () => {
    const n = createClaudeNormalizer(ctx());
    n.consume(assistant([{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "npm test", description: "run" } }]));
    const { events } = n.consume(userResult("tu2", "boom", { stdout: "boom", stderr: "!!", interrupted: false }, true));
    const bash = events.find((e) => e.kind === "bash");
    expect(bash?.payload).toMatchObject({ command: "npm test", exitCode: 1, outputChars: 6 });
  });

  it("maps Edit to file_edit and Write to file_created", () => {
    const n = createClaudeNormalizer(ctx());
    n.consume(assistant([{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/proj/b.ts", new_string: "xyz" } }]));
    const edit = n.consume(userResult("e1", "ok", { filePath: "/proj/b.ts", newString: "xyz" })).events;
    expect(edit.find((e) => e.kind === "file_edit")?.payload).toMatchObject({ path: "/proj/b.ts", chars: 3 });

    n.consume(assistant([{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/proj/c.ts", content: "hello" } }]));
    const write = n.consume(userResult("w1", "ok", { type: "create", filePath: "/proj/c.ts", content: "hello" })).events;
    expect(write.find((e) => e.kind === "file_created")?.payload).toMatchObject({ path: "/proj/c.ts", chars: 5 });
  });

  it("forks a subagent lane for Agent/Task and registers the spawn", () => {
    const n = createClaudeNormalizer(ctx());
    n.consume(
      assistant([{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "Explore", description: "map core", prompt: "go" } }])
    );
    const { events, spawns } = n.consume(
      userResult("a1", "done", { isAsync: false, status: "completed", agentId: "abc123", outputFile: "/tmp/x.output" })
    );
    const spawn = events.find((e) => e.kind === "subagent_spawned");
    expect(spawn?.agentId).toBe("abc123");
    expect(spawn?.agentRole).toBe("subagent");
    expect(spawn?.payload).toMatchObject({ agent: "Explore", agentId: "abc123", description: "map core" });
    expect(spawns).toEqual([
      { agentId: "abc123", outputFile: "/tmp/x.output", label: "Explore", parentSessionId: "S1", parentRunId: "S1" }
    ]);
  });

  it("records a genuine typed prompt but ignores tool-result user lines", () => {
    const n = createClaudeNormalizer(ctx());
    const typed = n.consume({ type: "user", sessionId: "S1", promptSource: "typed", message: { content: "do the thing" } }).events;
    expect(typed.find((e) => e.kind === "message")?.payload).toMatchObject({ role: "user", text: "do the thing" });

    const injected = n.consume({ type: "user", sessionId: "S1", isMeta: true, message: { content: "system note" } }).events;
    expect(injected).toHaveLength(0);
  });

  it("maps a compact_boundary system line to context_compacted", () => {
    const n = createClaudeNormalizer(ctx());
    const { events } = n.consume({ type: "system", subtype: "compact_boundary", sessionId: "S1" });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("context_compacted");
  });

  it("stamps the subagent lane when consuming an agent-file context", () => {
    const n = createClaudeNormalizer({ runId: "PARENT", defaultSessionId: "sub", agent: { agentId: "abc123", parentSessionId: "S1" } });
    n.consume(assistant([{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/proj/d.ts" } }]));
    const { events } = n.consume(userResult("r1", "x", { type: "text", file: { filePath: "/proj/d.ts", content: "x" } }));
    const read = events.find((e) => e.kind === "file_read");
    expect(read?.runId).toBe("PARENT");
    expect(read?.agentId).toBe("abc123");
    expect(read?.agentRole).toBe("subagent");
    expect(read?.parentSessionId).toBe("S1");
  });
});
