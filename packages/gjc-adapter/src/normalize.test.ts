import { describe, expect, it } from "vitest";
import { createTraceEvent } from "@agent-blackbox/core";
import { createGjcNormalizer } from "./normalize.js";

const ctx = {
  defaultSessionId: "sess-1",
  homeDir: "/home/alice",
  projectDir: "/home/alice/project"
};

describe("gjc normalizer", () => {
  it("normalizes session and model transcript records", () => {
    const normalizer = createGjcNormalizer(ctx);
    const events = [
      ...normalizer.consume({ type: "session", version: 3, id: "sess-1", timestamp: "2026-06-25T00:00:00.000Z", cwd: "/home/alice/project" }),
      ...normalizer.consume({ type: "model_change", model: "layofflabs/gpt-5.5", timestamp: "2026-06-25T00:00:01.000Z" })
    ];

    expect(events.map((e) => e.kind)).toEqual(["session_created", "model_switched"]);
    expect(events.every((e) => e.host === "gjc")).toBe(true);
    expect(createTraceEvent(1, events[0]!)).toMatchObject({ host: "gjc", runId: "sess-1" });
  });

  it("pairs assistant tool calls with tool results from real GJC message records", () => {
    const normalizer = createGjcNormalizer(ctx);
    const events = [
      ...normalizer.consume({
        type: "message",
        sessionId: "sess-1",
        timestamp: "2026-06-25T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/home/alice/project/src/secret.ts" } }]
        }
      }),
      ...normalizer.consume({
        type: "message",
        sessionId: "sess-1",
        timestamp: "2026-06-25T00:00:03.000Z",
        message: { role: "tool", content: [{ type: "toolResult", toolCallId: "call-1", output: { content: "sk-ant-123456789012345678901234" } }] }
      })
    ];

    expect(events.map((e) => e.kind)).toEqual(["tool_call", "file_read"]);
    expect(events[1]?.summary).toBe("Read $PROJECT/src/secret.ts");
    expect(events[1]?.payload).toEqual({ path: "$PROJECT/src/secret.ts", chars: 31 });
  });

  it("normalizes direct synthetic tool records for fixture-driven coverage", () => {
    const normalizer = createGjcNormalizer(ctx);
    const raw = [
      { type: "tool_call", id: "bash-1", name: "bash", input: { command: "npm test" } },
      { type: "tool_result", toolCallId: "bash-1", output: { stdout: "ok\n", stderr: "" } },
      { type: "tool_call", id: "edit-1", name: "edit", input: { path: "/home/alice/project/src/a.ts", replacement: "const a = 1;" } },
      { type: "tool_result", toolCallId: "edit-1", output: {} },
      { type: "tool_call", id: "search-1", name: "search", input: { pattern: "TODO" } },
      { type: "tool_result", toolCallId: "search-1", output: {} },
      { type: "tool_call", id: "todo-1", name: "todo_write", input: {} },
      { type: "tool_result", toolCallId: "todo-1", output: {} },
      { type: "tool_call", id: "task-1", name: "task", input: { agent: "executor" } },
      { type: "tool_result", toolCallId: "task-1", output: { agentId: "0-Executor" } },
      { type: "compact_boundary" },
      { type: "unknown_future_record" }
    ];

    const events = raw.flatMap((line) => normalizer.consume(line));
    expect(events.map((e) => e.kind)).toEqual([
      "tool_call",
      "bash",
      "tool_call",
      "file_edit",
      "tool_call",
      "search",
      "tool_call",
      "todo_updated",
      "tool_call",
      "subagent_spawned",
      "context_compacted",
      "host_event"
    ]);
    expect(events.find((e) => e.kind === "subagent_spawned")).toMatchObject({ agentRole: "subagent", agentId: "0-Executor" });
  });

  it("redacts summaries, payloads, and lane labels without storing raw transcript bodies", () => {
    const normalizer = createGjcNormalizer({ ...ctx, agent: { agentId: "agent-1" } });
    const events = normalizer.consume({
      type: "message",
      sessionId: "sess-1",
      message: { role: "user", content: "Investigate /home/alice/project and token ghp_123456789012345678901234567890" }
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("/home/alice/project");
    expect(serialized).not.toContain("ghp_123456789012345678901234567890");
    expect(serialized).toContain("$PROJECT");
    expect(events[0]?.payload).toEqual({ role: "user", chars: 76 });
    expect(events[0]?.redaction?.rawStored).toBe(false);
  });

  it("redacts cwd and top-level subagent lane fields", () => {
    const normalizer = createGjcNormalizer(ctx);
    const events = [
      ...normalizer.consume({
        type: "session",
        sessionId: "sess-1",
        cwd: "/home/alice/project/private",
        timestamp: "2026-06-25T00:00:00.000Z"
      }),
      ...normalizer.consume({ type: "tool_call", id: "task-secret", name: "task", input: { description: "inspect /home/alice/project with token ghp_123456789012345678901234567890" } }),
      ...normalizer.consume({ type: "tool_result", toolCallId: "task-secret", output: { agentId: "worker-ghp_123456789012345678901234567890" } })
    ];

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("/home/alice/project");
    expect(serialized).not.toContain("ghp_123456789012345678901234567890");
    expect(events[0]?.cwd).toBe("$PROJECT/private");
    expect(events.find((e) => e.kind === "subagent_spawned")).toMatchObject({
      agentId: "worker-[REDACTED_GITHUB_TOKEN]",
      agentLabel: "inspect $PROJECT with token [REDACTED_GITHUB_TOKEN]"
    });
  });
});
