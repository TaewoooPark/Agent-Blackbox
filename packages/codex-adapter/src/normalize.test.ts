import { describe, expect, it } from "vitest";
import { createCodexNormalizer } from "./normalize.js";

const rootId = "019f64f4-4b7c-75e2-bb37-c285d74b2ddd";
const ts = "2026-07-15T08:46:01.354Z";

function normalizer() {
  return createCodexNormalizer({ defaultSessionId: rootId, homeDir: "/Users/test", projectDir: "/Users/test/project" });
}

describe("Codex rollout normalizer", () => {
  it("records session, turn, prompt, token telemetry, and completion", () => {
    const n = normalizer();
    expect(n.consume({ timestamp: ts, type: "session_meta", payload: { id: rootId, session_id: rootId, cwd: "/Users/test/project", source: "exec", cli_version: "0.144.4" } })[0]).toMatchObject({ host: "codex", runId: rootId, kind: "session_created" });
    n.consume({ timestamp: ts, type: "turn_context", payload: { turn_id: "turn-1", cwd: "/Users/test/project", model: "gpt-test" } });
    expect(n.consume({ timestamp: ts, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } })[0]).toMatchObject({ kind: "turn_start", turnId: "turn-1" });
    expect(n.consume({ timestamp: ts, type: "event_msg", payload: { type: "user_message", message: "fix it" } })[0]).toMatchObject({ kind: "message", payload: { role: "user", text: "fix it" } });
    expect(n.consume({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } } } })[0]).toMatchObject({ kind: "message", payload: { role: "assistant", model: "gpt-test", tokens: { input: 100, output: 10, cache: { read: 60, write: 0 } } } });
    expect(n.consume({ timestamp: ts, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 123 } })[0]).toMatchObject({ kind: "turn_end", payload: { durationMs: 123 } });
  });

  it("normalizes code-mode exec reads/searches and pairs their result", () => {
    const n = normalizer();
    n.consume({ timestamp: ts, type: "session_meta", payload: { id: rootId, session_id: rootId, cwd: "/Users/test/project" } });
    const code = `const r = await tools.exec_command({"cmd":"sed -n '1,200p' input.txt && rg -n needle input.txt","workdir":"/Users/test/project"});\ntext(r.output);`;
    expect(n.consume({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: code } })[0]).toMatchObject({ kind: "tool_call", payload: { tool: "bash" } });
    const result = n.consume({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "alpha\nneedle\n" }] } });
    expect(result.map((event) => event.kind)).toEqual(["file_read", "search"]);
    expect(result[0]).toMatchObject({ payload: { path: "input.txt" } });
  });

  it("uses structured patch changes without duplicating the output fallback", () => {
    const n = normalizer();
    n.consume({ timestamp: ts, type: "session_meta", payload: { id: rootId, session_id: rootId, cwd: "/Users/test/project" } });
    const code = `const patch = "*** Begin Patch\\n*** Update File: input.txt\\n@@\\n-old\\n+new\\n*** End Patch";\ntext(await tools.apply_patch(patch));`;
    n.consume({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", call_id: "patch-1", name: "exec", input: code } });
    const patch = n.consume({ timestamp: ts, type: "event_msg", payload: { type: "patch_apply_end", call_id: "inner-patch-id", success: true, changes: { "/Users/test/project/input.txt": { type: "update", unified_diff: "-old\n+new" } } } });
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({ kind: "file_edit", payload: { path: "$PROJECT/input.txt" } });
    expect(n.consume({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "patch-1", output: "{}" } })).toEqual([]);
  });

  it("prefers structured exec events without duplicating a response-item fallback", () => {
    const n = normalizer();
    n.consume({ timestamp: ts, type: "session_meta", payload: { id: rootId, session_id: rootId, cwd: "/Users/test/project" } });
    const code = `const r = await tools.exec_command({"cmd":"rg -n needle input.txt && cat input.txt","workdir":"/Users/test/project"});\ntext(r.output);`;
    expect(n.consume({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call", call_id: "outer", name: "exec", input: code } })).toHaveLength(1);
    expect(n.consume({ timestamp: ts, type: "event_msg", payload: { type: "exec_command_begin", call_id: "inner", turn_id: "turn-1", command: ["/bin/zsh", "-lc", "rg -n needle input.txt && cat input.txt"], cwd: "/Users/test/project" } })).toEqual([]);
    const result = n.consume({ timestamp: ts, type: "event_msg", payload: { type: "exec_command_end", call_id: "inner", turn_id: "turn-1", command: ["/bin/zsh", "-lc", "rg -n needle input.txt && cat input.txt"], cwd: "/Users/test/project", aggregated_output: "2:needle\nalpha\nneedle\n", exit_code: 0, status: "completed" } });
    expect(result.map((event) => event.kind)).toEqual(["search", "file_read"]);
    expect(n.consume({ timestamp: ts, type: "response_item", payload: { type: "custom_tool_call_output", call_id: "outer", output: "ok" } })).toEqual([]);
  });

  it("emits paired MCP call/result events from a structured completion", () => {
    const n = normalizer();
    n.consume({ timestamp: ts, type: "session_meta", payload: { id: rootId, session_id: rootId, cwd: "/Users/test/project" } });
    const events = n.consume({ timestamp: ts, type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: "mcp-1", invocation: { server: "figma", tool: "inspect" }, result: { Ok: { content: [{ type: "text", text: "done" }], is_error: false } } } });
    expect(events.map((event) => event.kind)).toEqual(["tool_call", "tool_result"]);
    expect(events[1]).toMatchObject({ payload: { tool: "mcp__figma__inspect", success: true } });
  });

  it("groups subagent files under the root run and labels their lane", () => {
    const n = createCodexNormalizer({ defaultSessionId: "child" });
    const event = n.consume({
      timestamp: ts,
      type: "session_meta",
      payload: {
        id: "child",
        session_id: rootId,
        parent_thread_id: rootId,
        thread_source: "subagent",
        agent_path: "/root/reviewer",
        cwd: "/project"
      }
    })[0];
    expect(event).toMatchObject({ host: "codex", runId: rootId, sessionId: rootId, kind: "agent_start", agentId: "/root/reviewer", agentLabel: "reviewer", agentRole: "subagent", parentSessionId: rootId });
  });

  it("records subagent spawn, compaction, and redacts secrets", () => {
    const n = normalizer();
    n.consume({ timestamp: ts, type: "session_meta", payload: { id: rootId, session_id: rootId, cwd: "/Users/test/project" } });
    const spawn = n.consume({ timestamp: ts, type: "event_msg", payload: { type: "sub_agent_activity", kind: "started", agent_thread_id: "child", agent_path: "/root/reviewer" } })[0];
    expect(spawn).toMatchObject({ kind: "subagent_spawned", agentId: "child", agentLabel: "reviewer" });
    expect(n.consume({ timestamp: ts, type: "event_msg", payload: { type: "context_compacted" } })[0]).toMatchObject({ kind: "context_compacted" });

    const call = JSON.stringify({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' example.test" });
    n.consume({ timestamp: ts, type: "response_item", payload: { type: "function_call", call_id: "secret", name: "shell_command", arguments: call } });
    const result = n.consume({ timestamp: ts, type: "response_item", payload: { type: "function_call_output", call_id: "secret", output: "ok" } })[0];
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(result)).toContain("REDACTED_TOKEN");
  });
});
