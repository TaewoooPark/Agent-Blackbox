import { describe, expect, it } from "vitest";
import { createTraceEvent } from "./events.js";
import { materializeWorkflowGraph } from "./graph.js";
import { evaluatePromiseChecks, generateHandoffMarkdown } from "./audit.js";

describe("promise checks", () => {
  it("verifies model test claims against observed bash events", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-audit",
        sessionId: "session-audit",
        kind: "message",
        payload: { role: "assistant", text: "I ran the tests and updated the implementation." }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-audit",
        sessionId: "session-audit",
        kind: "bash",
        payload: { command: "npm test", exitCode: 0 }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-audit",
        sessionId: "session-audit",
        kind: "file_edit",
        payload: { path: "src/index.ts" }
      })
    ];

    expect(evaluatePromiseChecks(events).map((check) => check.status)).toEqual(["verified", "verified"]);
  });

  it("flags unsupported model claims", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-audit",
        sessionId: "session-audit",
        kind: "message",
        payload: { role: "assistant", text: "I ran the tests." }
      })
    ];

    expect(evaluatePromiseChecks(events)).toEqual([
      {
        claim: "tests-run: I ran the tests.",
        status: "unverified",
        evidenceEventIds: [],
        severity: "warning"
      }
    ]);
  });
});

describe("handoff markdown", () => {
  it("summarizes graph state and promise checks", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-handoff",
        sessionId: "session-handoff",
        kind: "file_read",
        payload: { path: "src/index.ts" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-handoff",
        sessionId: "session-handoff",
        kind: "bash",
        payload: { command: "npm test", exitCode: 1 }
      })
    ];
    const markdown = generateHandoffMarkdown(materializeWorkflowGraph(events), [
      {
        claim: "tests-run: I ran the tests.",
        status: "verified",
        evidenceEventIds: ["evt_run-handoff_000002"],
        severity: "info"
      }
    ]);

    expect(markdown).toContain("## Files In Play");
    expect(markdown).toContain("src/index.ts");
    expect(markdown).toContain("VERIFIED");
    expect(markdown).toContain("Inspect the latest failed command");
  });
});

