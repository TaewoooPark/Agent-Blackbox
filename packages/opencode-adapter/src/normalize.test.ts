import { describe, expect, it } from "vitest";
import { normalizeOpenCodeEvent, normalizeToolBefore } from "./normalize.js";

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
});

