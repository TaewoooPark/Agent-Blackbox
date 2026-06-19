import { describe, expect, it } from "vitest";
import {
  normalizeOpenCodeEvent,
  normalizeSyntheticUserPrompt,
  normalizeToolAfter,
  normalizeToolBefore,
  shouldRecordOpenCodeEvent
} from "./normalize.js";

describe("OpenCode event normalization", () => {
  it("recovers the session id from nested provider properties", () => {
    const event = normalizeOpenCodeEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_real",
          part: { type: "text" }
        }
      },
      {
        runId: "run-opencode",
        seq: 1,
        defaultSessionId: "unknown-session"
      }
    );

    expect(event.sessionId).toBe("ses_real");
  });

  it("drops high-volume streaming and lifecycle bus events", () => {
    expect(shouldRecordOpenCodeEvent({ type: "message.part.delta" })).toBe(false);
    expect(shouldRecordOpenCodeEvent({ type: "catalog.updated" })).toBe(false);
    expect(shouldRecordOpenCodeEvent({ type: "plugin.added" })).toBe(false);
    expect(shouldRecordOpenCodeEvent({ type: "integration.updated" })).toBe(false);
  });

  it("keeps operational events and unknown shapes", () => {
    expect(shouldRecordOpenCodeEvent({ type: "file.edited" })).toBe(true);
    expect(shouldRecordOpenCodeEvent({ type: "message.updated" })).toBe(true);
    expect(shouldRecordOpenCodeEvent({ type: "session.created" })).toBe(true);
    expect(shouldRecordOpenCodeEvent({})).toBe(true);
  });

  it("turns the task tool into a subagent_spawned moment attributed to the subagent", () => {
    const event = normalizeToolAfter(
      { tool: "task", sessionID: "ses_parent" },
      { args: { subagent_type: "general", description: "List functions", prompt: "List exports of calc.js" } },
      { runId: "run-opencode", seq: 7, defaultSessionId: "unknown-session" }
    );

    expect(event.kind).toBe("subagent_spawned");
    expect(event.agentId).toBe("general");
    expect(event.agentRole).toBe("subagent");
    expect(event.payload.description).toBe("List functions");
  });

  it("maps file edited events to canonical file_edit trace events", () => {
    const event = normalizeOpenCodeEvent(
      {
        type: "file.edited",
        sessionID: "session-1",
        agent: { id: "build" },
        path: "src/index.ts"
      },
      {
        runId: "run-opencode",
        seq: 1,
        defaultSessionId: "fallback-session",
        projectDir: "/repo"
      }
    );

    expect(event.kind).toBe("file_edit");
    expect(event.sessionId).toBe("session-1");
    expect(event.agentId).toBe("build");
    expect(event.payload.path).toBe("src/index.ts");
    expect(event.host).toBe("opencode");
  });

  it("maps a slash command to command_run (not bash) and keeps the command name", () => {
    const event = normalizeOpenCodeEvent(
      { type: "command.executed", properties: { name: "init", sessionID: "session-1", arguments: "" } },
      { runId: "run-opencode", seq: 1, defaultSessionId: "fallback-session" }
    );
    expect(event.kind).toBe("command_run");
    expect((event.payload as { properties?: { name?: string } }).properties?.name).toBe("init");
  });

  it("maps session.compacted to a context_compacted node", () => {
    const event = normalizeOpenCodeEvent(
      { type: "session.compacted", properties: { sessionID: "session-1" } },
      { runId: "run-opencode", seq: 1, defaultSessionId: "fallback-session" }
    );
    expect(event.kind).toBe("context_compacted");
    expect(event.sessionId).toBe("session-1");
  });

  it("redacts secrets from tool payloads", () => {
    const event = normalizeToolBefore(
      {
        tool: "bash",
        sessionID: "session-1"
      },
      {
        args: {
          command: "echo gho_abcdefghijklmnopqrstuvwxyz1234567890"
        }
      },
      {
        runId: "run-opencode",
        seq: 2,
        defaultSessionId: "fallback-session"
      }
    );

    const output = event.payload.output as { args?: { command?: string } };
    expect(event.kind).toBe("tool_call");
    expect(output.args?.command).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(event.redaction.rulesApplied).toContain("github-token");
  });

  it("handles circular host payloads without throwing", () => {
    const input: Record<string, unknown> = { tool: "custom", sessionID: "session-1" };
    input.self = input;

    const event = normalizeToolBefore(input, {}, {
      runId: "run-opencode",
      seq: 3,
      defaultSessionId: "fallback-session"
    });

    const payloadInput = event.payload.input as { self?: string };
    expect(payloadInput.self).toBe("[Circular]");
  });

  it("promotes completed read tools to redacted file_read events", () => {
    const event = normalizeToolAfter(
      {
        tool: "read",
        sessionID: "session-1",
        args: {
          filePath: "/repo/README.md"
        }
      },
      {
        output: "<content>private file body</content>",
        metadata: {
          preview: "Project README",
          display: { path: "/repo/README.md" },
          truncated: false
        }
      },
      {
        runId: "run-opencode",
        seq: 4,
        defaultSessionId: "fallback-session",
        projectDir: "/repo"
      }
    );

    expect(event.kind).toBe("file_read");
    expect(event.payload.path).toBe("$PROJECT/README.md");
    expect(event.payload.preview).toBe("Project README");
    expect(JSON.stringify(event.payload)).not.toContain("private file body");
  });

  it("promotes completed bash tools to command events with exit codes", () => {
    const event = normalizeToolAfter(
      {
        tool: "bash",
        sessionID: "session-1",
        args: {
          command: "npm test",
          description: "Run tests"
        }
      },
      {
        metadata: {
          output: "pass",
          exit: 0,
          truncated: false
        }
      },
      {
        runId: "run-opencode",
        seq: 5,
        defaultSessionId: "fallback-session"
      }
    );

    expect(event.kind).toBe("bash");
    expect(event.summary).toBe("Ran npm test");
    expect(event.payload.command).toBe("npm test");
    expect(event.payload.exitCode).toBe(0);
    expect(event.payload.outputPreview).toBe("pass");
  });

  it("records read/bash/edit content sizes without storing the content", () => {
    const bigBody = Array.from({ length: 120 }, (_, i) => `line ${i} of a secret file`).join("\n");
    const read = normalizeToolAfter(
      { tool: "read", sessionID: "s", args: { filePath: "/repo/big.ts" } },
      { output: bigBody, metadata: { preview: "line 0", display: { path: "/repo/big.ts" } } },
      { runId: "r", seq: 1, defaultSessionId: "s", projectDir: "/repo" }
    );
    expect(read.payload.chars).toBe(bigBody.length);
    expect(read.payload.lines).toBe(120);
    expect(JSON.stringify(read.payload)).not.toContain("secret file");

    const bash = normalizeToolAfter(
      { tool: "bash", sessionID: "s", args: { command: "grep -r TODO" } },
      { metadata: { output: "a\nb\nc\nd", exit: 0 } },
      { runId: "r", seq: 2, defaultSessionId: "s" }
    );
    expect(bash.payload.outputChars).toBe(7);
    expect(bash.payload.outputLines).toBe(4);

    const edit = normalizeToolAfter(
      { tool: "write", sessionID: "s", args: { filePath: "/repo/out.ts", content: "export const x = 1;\n" } },
      {},
      { runId: "r", seq: 3, defaultSessionId: "s", projectDir: "/repo" }
    );
    expect(edit.payload.chars).toBe("export const x = 1;\n".length);
    expect(edit.payload.lines).toBe(2);
  });

  it("promotes a completed skill tool to a named tool_result event", () => {
    const event = normalizeToolAfter(
      {
        tool: "skill",
        sessionID: "session-1",
        args: { name: "algorithmic-art" }
      },
      {
        title: "Loaded skill: algorithmic-art"
      },
      {
        runId: "run-opencode",
        seq: 6,
        defaultSessionId: "fallback-session"
      }
    );

    expect(event.kind).toBe("tool_result");
    expect(event.summary).toBe("Used the algorithmic-art skill");
    expect(event.payload.tool).toBe("skill");
    expect(event.payload.skill).toBe("algorithmic-art");
  });

  it("keeps an unrecognized tool as a renderable tool_result instead of dropping it", () => {
    const event = normalizeToolAfter(
      {
        tool: "grep",
        sessionID: "session-1",
        args: { pattern: "TODO" }
      },
      {},
      {
        runId: "run-opencode",
        seq: 7,
        defaultSessionId: "fallback-session"
      }
    );

    expect(event.kind).toBe("tool_result");
    expect(event.summary).toBe("Used grep");
    expect(event.payload.tool).toBe("grep");
  });

  it("does not store raw OpenCode message text in default event payloads", () => {
    const event = normalizeOpenCodeEvent(
      {
        id: "evt-message",
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: {
            id: "part-1",
            type: "text",
            text: "SECRET_PROMPT_OR_REASONING",
            messageID: "message-1",
            state: {
              status: "completed",
              output: "SECRET_TOOL_OUTPUT"
            }
          },
          delta: "SECRET_DELTA"
        }
      },
      {
        runId: "run-opencode",
        seq: 6,
        defaultSessionId: "fallback-session"
      }
    );

    const serialized = JSON.stringify(event.payload);
    expect(serialized).not.toContain("SECRET_PROMPT_OR_REASONING");
    expect(serialized).not.toContain("SECRET_TOOL_OUTPUT");
    expect(serialized).not.toContain("SECRET_DELTA");
    expect(event.payload.properties).toMatchObject({
      sessionID: "session-1",
      messageID: "message-1",
      deltaLength: 12,
      part: {
        id: "part-1",
        type: "text",
        stateStatus: "completed"
      }
    });
  });

  it("keeps user prompt text for prompt timeline nodes", () => {
    const event = normalizeOpenCodeEvent(
      {
        id: "evt-user-message",
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "message-1",
            role: "user",
            text: "Please inspect src/calc.js and fix the failing test."
          }
        }
      },
      {
        runId: "run-opencode",
        seq: 7,
        defaultSessionId: "fallback-session",
        projectDir: "/repo"
      }
    );

    expect(event.payload.properties).toMatchObject({
      sessionID: "session-1",
      messageID: "message-1",
      role: "user",
      text: "Please inspect src/calc.js and fix the failing test."
    });
  });

  it("marks OpenCode message agents as primary by default", () => {
    const event = normalizeOpenCodeEvent(
      {
        id: "evt-message",
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          role: "assistant",
          agent: "build"
        }
      },
      {
        runId: "run-opencode",
        seq: 8,
        defaultSessionId: "fallback-session"
      }
    );

    expect(event.agentId).toBe("build");
    expect(event.agentRole).toBe("primary");
  });

  it("creates a redacted synthetic prompt from opencode run argv", () => {
    const session = normalizeOpenCodeEvent(
      {
        type: "session.created",
        sessionID: "session-1"
      },
      {
        runId: "run-opencode",
        seq: 9,
        defaultSessionId: "fallback-session",
        projectDir: "/repo"
      }
    );
    const prompt = normalizeSyntheticUserPrompt("Please edit /repo/src/calc.js", session, {
      runId: "run-opencode",
      seq: 10,
      defaultSessionId: "fallback-session",
      projectDir: "/repo"
    });

    expect(prompt.kind).toBe("message");
    expect(prompt.payload.properties).toMatchObject({
      role: "user",
      text: "Please edit $PROJECT/src/calc.js"
    });
  });
});
