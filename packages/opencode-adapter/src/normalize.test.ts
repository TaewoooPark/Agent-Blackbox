import { describe, expect, it } from "vitest";
import { normalizeOpenCodeEvent, normalizeToolAfter, normalizeToolBefore } from "./normalize.js";

describe("OpenCode event normalization", () => {
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
});
