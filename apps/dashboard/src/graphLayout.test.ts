import type { WorkflowGraph } from "@agent-blackbox/core";
import { createTraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";
import {
  createAgentTreeLayout,
  createTimelineMarks,
  createWorkflowSteps,
  filterWorkflowStepsBySeq,
  layoutGraphNodes,
  summarizeGraph,
  visibleEventsForGraph
} from "./graphLayout.js";

const graph: WorkflowGraph = {
  runId: "run-ui",
  appliedEventIds: ["evt_1", "evt_2"],
  nodes: [
    {
      id: "agent:a",
      type: "AGENT",
      label: "a",
      status: "ACTIVE",
      createdAt: "2026-06-16T00:00:01.000Z",
      updatedAt: "2026-06-16T00:00:01.000Z",
      eventIds: ["evt_1"],
      data: {}
    },
    {
      id: "decision:d",
      type: "DECISION",
      label: "Use existing parser",
      status: "SUCCEEDED",
      createdAt: "2026-06-16T00:00:02.000Z",
      updatedAt: "2026-06-16T00:00:02.000Z",
      eventIds: ["evt_2"],
      data: {}
    }
  ],
  edges: []
};

describe("dashboard graph helpers", () => {
  it("summarizes operational graph state", () => {
    expect(summarizeGraph(graph)).toMatchObject({
      runId: "run-ui",
      nodes: 2,
      activeAgents: 1,
      decisions: 1
    });
  });

  it("places operational lanes deterministically", () => {
    const [agent, decision] = layoutGraphNodes(graph);

    expect(agent?.type).toBe("AGENT");
    expect(decision?.type).toBe("DECISION");
    expect(agent?.y).toBeLessThan(decision?.y ?? 0);
  });

  it("derives replay logs and visible events from observed trace state", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_read",
        payload: { path: "src/index.ts" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "bash",
        payload: { command: "npm test", exitCode: 1 }
      })
    ];

    const marks = createTimelineMarks(events);
    expect(marks.map((mark) => mark.label)).toEqual(["Read src/index.ts", "Tests failed"]);
    expect(marks[1]?.tone).toBe("risk");
    expect(visibleEventsForGraph(events, { ...graph, appliedEventIds: [events[0]!.id] }).map((event) => event.id)).toEqual([
      events[0]!.id
    ]);
  });

  it("filters noisy OpenCode provider and delta events out of the visible timeline", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "session_updated",
        summary: "plugin.added",
        payload: { type: "plugin.added" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "session_updated",
        summary: "message.part.delta",
        payload: { type: "message.part.delta" }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "message",
        payload: {
          properties: {
            role: "user",
            text: "Fix src/calc.ts"
          }
        }
      }),
      createTraceEvent(4, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "bash",
        payload: { command: "npm test", exitCode: 0 }
      })
    ];

    expect(createTimelineMarks(events).map((mark) => mark.label)).toEqual(["Fix src/calc.ts", "Tests passed"]);
  });

  it("builds workflow steps without exposing raw shell commands", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: { path: "src/calc.ts" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "bash",
        payload: { command: "npm test", exitCode: 0 }
      })
    ];

    const steps = createWorkflowSteps(events);

    expect(steps.map((step) => step.title)).toEqual(["Changed a file", "Tests passed"]);
    expect(steps[0]?.description).toContain("src/calc.ts was modified");
    expect(JSON.stringify(steps)).not.toContain("npm test");
    expect(steps[1]?.branches[0]).toMatchObject({
      kind: "verification",
      label: "Passed",
      detail: "tests"
    });
  });

  it("attaches reads and subagents as horizontal branches on the next trunk step", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_read",
        payload: { path: "src/calc.ts" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "reviewer",
        kind: "subagent_spawned",
        payload: {}
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: { path: "src/calc.ts" }
      })
    ];

    const steps = createWorkflowSteps(events);

    expect(steps.map((step) => step.title)).toEqual(["Changed a file"]);
    expect(steps[0]?.branches.map((branch) => branch.title)).toEqual([
      "Read a file",
      "Started a subagent branch",
      "Changed a file"
    ]);
    expect(steps[0]?.branches.map((branch) => branch.kind)).toEqual(["file", "agent", "file"]);
  });

  it("removes future workflow steps and branches during replay", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_read",
        payload: { path: "src/calc.ts" }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: { path: "src/calc.ts" }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "reviewer",
        kind: "subagent_spawned",
        payload: {}
      }),
      createTraceEvent(4, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_read",
        payload: { path: "src/late.ts" }
      }),
      createTraceEvent(5, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "bash",
        payload: { command: "npm test", exitCode: 0 }
      })
    ];

    const steps = createWorkflowSteps(events);
    const seqTwoSteps = filterWorkflowStepsBySeq(steps, 2);
    const seqThreeSteps = filterWorkflowStepsBySeq(steps, 3);
    const liveSteps = filterWorkflowStepsBySeq(steps, 5);

    expect(seqTwoSteps.map((step) => step.title)).toEqual(["Changed a file"]);
    expect(seqTwoSteps[0]?.branches.map((branch) => branch.label)).toEqual(["src/calc.ts", "src/calc.ts"]);
    expect(seqThreeSteps.map((step) => step.title)).toEqual(["Changed a file"]);
    expect(seqThreeSteps[0]?.branches.map((branch) => branch.label)).toContain("reviewer");
    expect(liveSteps.map((step) => step.title)).toEqual(["Changed a file", "Tests passed"]);
    expect(liveSteps[1]?.branches.map((branch) => branch.label)).toContain("src/late.ts");
  });

  it("creates genealogical tree lanes for subagents and nested agent branches", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "session_created",
        payload: {}
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: { path: "src/calc.ts" }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "reviewer",
        agentRole: "subagent",
        kind: "subagent_spawned",
        payload: {}
      }),
      createTraceEvent(4, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "reviewer",
        agentRole: "subagent",
        kind: "file_read",
        payload: { path: "src/calc.ts" }
      }),
      createTraceEvent(5, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "reviewer",
        agentRole: "subagent",
        kind: "decision_extracted",
        payload: { statement: "Reviewer accepted the calculator change." }
      }),
      createTraceEvent(6, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "auditor",
        agentRole: "subagent",
        kind: "subagent_spawned",
        payload: {}
      })
    ];

    const steps = createWorkflowSteps(events);
    const layout = createAgentTreeLayout(steps);
    const reviewerLane = layout.lanes.find((lane) => lane.label === "reviewer");
    const auditorLane = layout.lanes.find((lane) => lane.label === "auditor");
    const rootChange = steps.find((step) => step.title === "Changed a file");
    const reviewerDecision = steps.find((step) => step.agentLabel === "reviewer" && step.title === "Made a decision");

    expect(layout.lanes.map((lane) => lane.label)).toEqual(["main", "reviewer", "auditor"]);
    expect(reviewerLane).toMatchObject({
      parentLaneId: "root",
      anchorStepId: rootChange?.id
    });
    expect(auditorLane).toMatchObject({
      parentLaneId: "agent:reviewer",
      anchorStepId: reviewerDecision?.id
    });
    expect(layout.items.filter((item) => item.type === "agent-start").map((item) => item.laneId)).toEqual([
      "agent:reviewer",
      "agent:auditor"
    ]);
    expect(layout.connections.filter((connection) => connection.kind === "branch")).toHaveLength(2);
  });

  it("shows user prompts with file mentions and token deltas", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "message",
        payload: {
          properties: {
            role: "user",
            text: "Please update src/calc.ts and package.json before running tests."
          }
        }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "session_updated",
        payload: {
          properties: {
            info: {
              tokens: {
                input: 120,
                output: 12,
                reasoning: 3,
                cache: {
                  read: 5,
                  write: 0
                }
              }
            }
          }
        }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: { path: "src/calc.ts" }
      })
    ];

    const steps = createWorkflowSteps(events);

    expect(steps.map((step) => step.kind)).toEqual(["prompt", "change"]);
    expect(steps[0]?.description).toContain("Please update src/calc.ts");
    expect(steps[0]?.branches.map((branch) => branch.label)).toContain("$PROJECT/src/calc.ts");
    expect(steps[0]?.branches.map((branch) => branch.label)).toContain("$PROJECT/package.json");
    expect(new Set(steps[0]?.branches.map((branch) => branch.id)).size).toBe(steps[0]?.branches.length);
    expect(steps[0]?.tokens).toMatchObject({
      input: 120,
      output: 12,
      reasoning: 3,
      cacheRead: 5,
      total: 140
    });
  });

  it("does not duplicate a captured prompt with the later OpenCode session title", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "session_created",
        payload: {}
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "message",
        summary: "opencode.run.prompt",
        payload: {
          properties: {
            role: "user",
            text: "Fix the failing multiply test in src/calc.ts."
          }
        }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        agentId: "build",
        agentRole: "primary",
        kind: "session_updated",
        summary: "session.updated",
        payload: {
          properties: {
            info: {
              title: "Fix failing multiply test in calc",
              tokens: {
                input: 120,
                output: 12,
                reasoning: 3,
                cache: {
                  read: 0,
                  write: 0
                }
              }
            }
          }
        }
      }),
      createTraceEvent(4, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: { path: "src/calc.ts" }
      })
    ];

    const steps = createWorkflowSteps(events);
    const layout = createAgentTreeLayout(steps);

    expect(steps.map((step) => step.title)).toEqual(["Started a session", "Prompt received", "Changed a file"]);
    expect(layout.lanes.map((lane) => lane.label)).toEqual(["main"]);
    expect(steps[1]?.tokens.total).toBe(135);
  });
});
