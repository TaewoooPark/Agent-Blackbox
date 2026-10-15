import type { WorkflowGraph } from "@agent-blackbox/core";
import { createTraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";
import {
  createAgentTreeLayout,
  createTimelineMarks,
  createWorkflowSteps,
  filterWorkflowStepsBySeq,
  layoutGraphNodes,
  latestTokenUsage,
  summarizeGraph,
  visibleEventsForGraph,
  type WorkflowStep
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

  it("shows Motifcode test failures when the journal reports no exact exit code", () => {
    const event = createTraceEvent(1, {
      host: "motifcode", runId: "motif-ui", sessionId: "motif-ui", kind: "bash",
      payload: { command: "npm test", success: false }
    });
    expect(createTimelineMarks([event])[0]).toMatchObject({ label: "Tests failed", tone: "risk" });
    expect(createWorkflowSteps([event])[0]).toMatchObject({
      title: "Tests failed", tone: "risk", kind: "risk",
      branches: [expect.objectContaining({ label: "Failed", tone: "risk" })]
    });
  });

  it("renders compaction and slash-command events as their own clear nodes", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "command_run",
        payload: { type: "command.executed", properties: { name: "init" } }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "context_compacted",
        payload: { type: "session.compacted", properties: { sessionID: "session-ui" } }
      })
    ];

    const steps = createWorkflowSteps(events);
    expect(steps.map((step) => step.title)).toEqual(["Ran /init", "Context compacted"]);
    expect(steps[1]?.kind).toBe("context"); // compaction reads as a context-management moment
  });

  it("renders agent/model switches and an unmodeled host_event as visible nodes", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "agent_switched",
        payload: { type: "session.next.agent.switched", properties: { agent: "hephaestus" } }
      }),
      createTraceEvent(2, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "model_switched",
        payload: { type: "session.next.model.switched", properties: { model: { id: "gpt-5.5" } } }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "host_event",
        summary: "some.brand.new.event",
        payload: { type: "some.brand.new.event" }
      })
    ];

    const steps = createWorkflowSteps(events);
    expect(steps.map((step) => step.title)).toEqual([
      "Switched to hephaestus",
      "Switched model to gpt-5.5",
      "OpenCode: some.brand.new.event"
    ]);
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

  it("drops unresolvable relative file mentions from prompt text", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "message",
        summary: "opencode.run.prompt",
        payload: {
          properties: {
            role: "user",
            text: "Create src/mathutils/stats.js and import it from ./stats.js in the test."
          }
        }
      })
    ];

    const steps = createWorkflowSteps(events);
    const fileBranches = steps[0]?.branches.filter((branch) => branch.kind === "file") ?? [];
    const labels = fileBranches.map((branch) => branch.label);

    expect(labels).toContain("$PROJECT/src/mathutils/stats.js");
    expect(labels.some((label) => label.includes("/./") || label.endsWith("/."))).toBe(false);
  });

  it("understands nested file paths from provider watcher events", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        payload: {
          properties: {
            file: "$PROJECT/src/calc.js"
          }
        }
      })
    ];

    const steps = createWorkflowSteps(events);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.description).toContain("$PROJECT/src/calc.js");
  });

  it("merges watcher and tool-after file edits into one workflow moment", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        summary: "file.edited",
        payload: {
          type: "file.edited",
          properties: {
            file: "$PROJECT/src/calc.js"
          }
        }
      }),
      createTraceEvent(4, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        summary: "Edited $PROJECT/src/calc.js",
        payload: {
          source: "tool.after",
          path: "$PROJECT/src/calc.js"
        }
      })
    ];

    const steps = createWorkflowSteps(events);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.title).toBe("Changed a file");
    // The watcher event and the tool.after edit are the same file, so the file
    // appears exactly once, not duplicated.
    expect(steps[0]?.branches.filter((branch) => branch.kind === "file")).toHaveLength(1);
  });

  it("collapses a created file's watcher edit into one 'Created a file' moment", () => {
    const events = [
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_edit",
        summary: "file.edited",
        payload: { type: "file.edited", properties: { file: "$PROJECT/src/new.js" } }
      }),
      createTraceEvent(3, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_created",
        summary: "Edited $PROJECT/src/new.js",
        payload: { source: "tool.after", path: "$PROJECT/src/new.js" }
      })
    ];

    const steps = createWorkflowSteps(events);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.title).toBe("Created a file");
    const fileBranches = steps[0]?.branches.filter((branch) => branch.kind === "file") ?? [];
    expect(fileBranches).toHaveLength(1);
    expect(fileBranches[0]?.detail).toBe("created");
  });

  it("attributes a subagent's reads to its own lane as aggregated steps", () => {
    const read = (seq: number, file: string) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "ses-explore",
        agentId: "explore",
        agentRole: "subagent",
        kind: "file_read",
        summary: `Read ${file}`,
        payload: { source: "tool.after", path: file }
      });
    const steps = createWorkflowSteps([read(10, "$PROJECT/a.js"), read(11, "$PROJECT/b.js"), read(12, "$PROJECT/c.js")]);
    // The three reads collapse into one step on the explore lane.
    expect(steps).toHaveLength(1);
    expect(steps[0]?.agentLabel).toBe("explore");
    expect(steps[0]?.title).toBe("Read a file");
    const files = steps[0]?.branches.filter((branch) => branch.kind === "file").map((branch) => branch.label) ?? [];
    expect(files.sort()).toEqual(["$PROJECT/a.js", "$PROJECT/b.js", "$PROJECT/c.js"]);
  });

  it("aggregates consecutive file creations into one moment listing every file", () => {
    const mk = (seq: number, file: string) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "file_created",
        summary: `Edited ${file}`,
        payload: { source: "tool.after", path: file }
      });
    const steps = createWorkflowSteps([mk(1, "$PROJECT/a.js"), mk(2, "$PROJECT/b.js")]);
    expect(steps).toHaveLength(1);
    const files = steps[0]?.branches.filter((branch) => branch.kind === "file").map((branch) => branch.label) ?? [];
    expect(files.sort()).toEqual(["$PROJECT/a.js", "$PROJECT/b.js"]);
    // the first event's seq is retained so replay still reveals it at the right point
    expect(steps[0]?.seq).toBe(1);
  });

  it("renders a skill tool result as a named coordination moment", () => {
    const steps = createWorkflowSteps([
      createTraceEvent(1, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "tool_result",
        summary: "Used the algorithmic-art skill",
        payload: { source: "tool.after", tool: "skill", skill: "algorithmic-art" }
      })
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("coordination");
    expect(steps[0]?.title).toBe("Used the algorithmic-art skill");
  });

  it("renders an unrecognized tool result as a generic moment and collapses repeats", () => {
    const grep = (seq: number) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "tool_result",
        summary: "Used grep",
        payload: { source: "tool.after", tool: "grep" }
      });
    const steps = createWorkflowSteps([grep(1), grep(2), grep(3)]);
    // Three consecutive identical tool moments collapse into one.
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("coordination");
    expect(steps[0]?.title).toBe("Used grep");
    expect(steps[0]?.branches).toHaveLength(3);
  });

  it("keeps differently-named skills as separate moments", () => {
    const skill = (seq: number, name: string) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "tool_result",
        summary: `Used the ${name} skill`,
        payload: { source: "tool.after", tool: "skill", skill: name }
      });
    const steps = createWorkflowSteps([skill(1, "algorithmic-art"), skill(2, "frontend-design")]);
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.title)).toEqual([
      "Used the algorithmic-art skill",
      "Used the frontend-design skill"
    ]);
  });

  it("renders a todo update as a coordination moment and collapses repeats", () => {
    const todo = (seq: number, count: number) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "todo_updated",
        summary: "todo.updated",
        payload: { properties: { todos: Array.from({ length: count }, (_, i) => ({ id: i })) } }
      });
    const steps = createWorkflowSteps([todo(1, 2), todo(2, 3)]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("coordination");
    expect(steps[0]?.title).toBe("Updated the task list");
    expect(steps[0]?.branches.filter((b) => b.kind === "evidence")).toHaveLength(2);
  });

  it("renders a resolved permission as a risk when denied and a decision otherwise", () => {
    const reply = (seq: number, response: string) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "permission_replied",
        summary: "permission.replied",
        payload: { properties: { response } }
      });
    const [granted] = createWorkflowSteps([reply(1, "always")]);
    const [denied] = createWorkflowSteps([reply(1, "reject")]);
    expect(granted?.title).toBe("Resolved a permission request");
    expect(granted?.kind).toBe("decision");
    expect(denied?.kind).toBe("risk");
  });

  it("does not aggregate a passed test run with a failed one", () => {
    const bash = (seq: number, exit: number) =>
      createTraceEvent(seq, {
        host: "opencode",
        runId: "run-ui",
        sessionId: "session-ui",
        kind: "bash",
        summary: "Ran node test.js",
        payload: { source: "tool.after", command: "node test.js", exitCode: exit }
      });
    const steps = createWorkflowSteps([bash(1, 0), bash(2, 1)]);
    expect(steps).toHaveLength(2);
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

  it("keeps interleaved Motifcode siblings under their explicit spawning scope", () => {
    const event = (seq: number, kind: "message" | "agent_start", agentId?: string, parentScopeId?: string) => createTraceEvent(seq, {
      host: "motifcode", runId: "motif-agents", sessionId: "motif-agents", kind,
      ...(agentId ? { agentId, agentRole: "subagent" as const } : {}),
      payload: kind === "message" ? { role: "user", text: `Task for ${agentId ?? "main"}` } : { parentScopeId: parentScopeId! }
    });
    const steps = createWorkflowSteps([
      event(1, "message"),
      event(2, "agent_start", "review-one", "root"),
      event(3, "message", "review-one"),
      event(4, "agent_start", "review-two", "root"),
      event(5, "message", "review-two")
    ]);
    const layout = createAgentTreeLayout(steps);
    expect(layout.lanes.find((lane) => lane.id === "agent:review-one")?.parentLaneId).toBe("root");
    expect(layout.lanes.find((lane) => lane.id === "agent:review-two")?.parentLaneId).toBe("root");
    const main = steps.find((step) => step.agentLabel === undefined);
    expect(main?.branches.filter((branch) => branch.kind === "agent").map((branch) => branch.label)).toEqual(["review-one", "review-two"]);
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

  it("counts every Motifcode request once and attributes interleaved usage to its agent", () => {
    const event = (seq: number, payload: Record<string, unknown>, child = false) => createTraceEvent(seq, {
      host: "motifcode", runId: "motif-usage", sessionId: "motif-usage", kind: "message",
      ...(child ? { agentId: "review", agentRole: "subagent" as const, agentLabel: "Reviewer" } : {}),
      payload: payload as never
    });
    const usage = { role: "assistant", tokens: { input: 100, output: 10, cache: { read: 80 } } };
    const steps = createWorkflowSteps([
      event(1, { role: "user", text: "Implement the feature" }),
      event(2, { role: "user", text: "Review the patch" }, true),
      event(3, usage),
      event(4, usage, true),
      event(5, usage)
    ]);
    const root = steps.find((step) => step.agentLabel === undefined);
    const child = steps.find((step) => step.agentLabel === "review");
    expect(root?.tokens).toMatchObject({ input: 40, cacheRead: 160, output: 20, total: 220 });
    expect(child?.tokens).toMatchObject({ input: 20, cacheRead: 80, output: 10, total: 110 });
    expect(steps.reduce((sum, step) => sum + step.tokens.total, 0)).toBe(330);
  });

  it("shares correct latest-request token buckets with the dashboard context panel", () => {
    const event = (seq: number, payload: Record<string, unknown>, host: "motifcode" | "claude-code" = "motifcode") => createTraceEvent(seq, {
      host, runId: "latest-usage", sessionId: "latest-usage", kind: "message", payload: payload as never
    });
    const events = [
      event(1, { role: "assistant", tokens: { input: 100, output: 10 } }),
      event(2, { role: "assistant", tokens: { input: 5414, output: 89, cache: { read: 5120 } } }),
      event(3, { role: "assistant", text: "Completed" })
    ];
    expect(latestTokenUsage(events)).toEqual({ input: 294, output: 89, reasoning: 0, cacheRead: 5120, cacheWrite: 0, total: 5503 });
    expect(latestTokenUsage([events[1]!, events[0]!, events[2]!]).total).toBe(5503);
    expect(latestTokenUsage(events.slice(0, 1)).total).toBe(110);
    expect(latestTokenUsage([]).total).toBe(0);
    expect(latestTokenUsage([event(1, { tokens: { input: 294, output: 89, cache: { read: 5120 } } }, "claude-code")]).total).toBe(5503);
  });

  it("keeps usage seen before a lane's first action on that lane when attaching mid-run", () => {
    const event = (seq: number, kind: "message" | "file_edit", payload: Record<string, unknown>, child = false) => createTraceEvent(seq, {
      host: "motifcode", runId: "motif-attach", sessionId: "motif-attach", kind,
      ...(child ? { agentId: "review", agentRole: "subagent" as const } : {}), payload: payload as never
    });
    const usage = { role: "assistant", tokens: { input: 100, output: 10, cache: { read: 80 } } };
    const steps = createWorkflowSteps([
      event(1, "message", usage),
      event(2, "message", { role: "user", text: "Review the patch" }, true),
      event(3, "message", usage, true),
      event(4, "file_edit", { path: "root.ts" })
    ]);
    const total = (agent: string | undefined) => steps.filter((step) => step.agentLabel === agent).reduce((sum, step) => sum + step.tokens.total, 0);
    expect(total(undefined)).toBe(110);
    expect(total("review")).toBe(110);
    expect(createWorkflowSteps([event(1, "message", usage, true)])[0]).toMatchObject({ agentLabel: "review", tokens: { total: 110 } });
  });

  it("retains identical Motifcode tasks assigned to separate child scopes", () => {
    const events = ["review-one", "review-two"].map((agentId, index) => createTraceEvent(index + 1, {
      host: "motifcode", runId: "motif-prompts", sessionId: "motif-prompts", kind: "message",
      agentId, agentRole: "subagent", payload: { role: "user", text: "Review the code" }
    }));
    expect(createWorkflowSteps(events).map((step) => step.agentLabel)).toEqual(["review-one", "review-two"]);
  });

  it("retains explicit Motifcode parents when attaching after child starts", () => {
    const event = (seq: number, agentId?: string) => createTraceEvent(seq, {
      host: "motifcode", runId: "motif-attach", sessionId: "motif-attach", kind: "file_edit",
      ...(agentId ? { agentId, agentRole: "subagent" as const } : {}),
      payload: { path: `${seq}.ts`, ...(agentId ? { parentScopeId: "root" } : {}) }
    });
    const steps = createWorkflowSteps([event(1), event(2, "motif-attach:review"), event(3, "motif-attach:explore")]);
    const layout = createAgentTreeLayout(steps);
    expect(layout.lanes.slice(1).map((lane) => lane.parentLaneId)).toEqual(["root", "root"]);
    expect(layout.lanes.slice(1).map((lane) => lane.anchorStepId)).toEqual([steps[0]!.id, steps[0]!.id]);

    // If main's work also predates recording, show siblings with no invented
    // edge between them instead of using whichever child happened to run first.
    const withoutMain = createAgentTreeLayout(createWorkflowSteps([event(2, "motif-attach:review"), event(3, "motif-attach:explore")]));
    expect(withoutMain.lanes.slice(1).map((lane) => lane.parentLaneId)).toEqual(["root", "root"]);
    expect(withoutMain.connections.filter((edge) => edge.kind === "branch")).toHaveLength(0);
  });

  it("does not attach an explicit Motifcode sibling spawn to a child when main is unobserved", () => {
    const steps = createWorkflowSteps([
      createTraceEvent(1, {
        host: "motifcode", runId: "motif-attach", sessionId: "motif-attach", kind: "file_edit",
        agentId: "motif-attach:review", agentRole: "subagent", payload: { path: "review.ts", parentScopeId: "root" }
      }),
      createTraceEvent(2, {
        host: "motifcode", runId: "motif-attach", sessionId: "motif-attach", kind: "agent_start",
        agentId: "motif-attach:explore", agentRole: "subagent", agentLabel: "Explorer", payload: { parentScopeId: "root" }
      })
    ]);
    const layout = createAgentTreeLayout(steps);
    expect(layout.lanes.find((lane) => lane.label === "motif-attach:explore")).toMatchObject({
      parentLaneId: "root", anchorStepId: null,
      startBranch: { label: "motif-attach:explore", agentName: "Explorer" }
    });
    expect(layout.connections.filter((edge) => edge.kind === "branch")).toHaveLength(0);
  });

  it("names a Motifcode skill from its canonical command payload", () => {
    const steps = createWorkflowSteps([createTraceEvent(1, {
      host: "motifcode", runId: "motif-skill", sessionId: "motif-skill", kind: "command_run",
      payload: { tool: "skill", command: "debug" }
    })]);
    expect(steps[0]?.title).toBe("Ran /debug");
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

  it("labels a Claude Code model switch with the real model name (payload.model)", () => {
    const events = [
      createTraceEvent(1, { host: "claude-code", runId: "r", sessionId: "s", kind: "message", payload: { role: "assistant", model: "claude-opus-4-8" } }),
      createTraceEvent(2, { host: "claude-code", runId: "r", sessionId: "s", kind: "model_switched", summary: "Model → claude-haiku-4-5", payload: { model: "claude-haiku-4-5" } })
    ];
    const steps = createWorkflowSteps(events);
    expect(steps.some((step) => step.title === "Switched model to claude-haiku-4-5")).toBe(true);
  });

  it("renders a Claude Code prompt (top-level payload role/text) as a Prompt received step", () => {
    const events = [
      createTraceEvent(1, {
        host: "claude-code",
        runId: "r",
        sessionId: "s",
        kind: "message",
        summary: "user prompt",
        payload: { role: "user", text: "Add a modulo operation to the ledger." }
      }),
      createTraceEvent(2, { host: "claude-code", runId: "r", sessionId: "s", kind: "file_edit", payload: { path: "src/ledger.ts", chars: 10 } })
    ];
    const steps = createWorkflowSteps(events);
    expect(steps.map((step) => step.title)).toContain("Prompt received");
  });
});

// Lane ordering walks parents down from the root, so a lane that ends up as its own
// parent silently drops out of the genealogy. That shape is reachable in normal use:
// the tailer starts at the END of a transcript, so the spawn that opens a lane can be
// the first one we ever see and can land on a step already attributed to that lane.
describe("agent tree lane genealogy", () => {
  const laneStep = (id: string, seq: number, agentLabel?: string, branchLabel?: string): WorkflowStep =>
    ({
      id,
      eventId: `e${seq}`,
      seq,
      ts: `2026-01-01T00:00:0${seq}.000Z`,
      kind: "context",
      title: "t",
      description: "d",
      tone: "neutral",
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      branches: branchLabel
        ? [
            {
              id: `b${seq}`,
              eventId: `e${seq}`,
              seq,
              ts: `2026-01-01T00:00:0${seq}.000Z`,
              kind: "agent",
              label: branchLabel,
              description: "d",
              detail: "sub",
              tone: "neutral"
            }
          ]
        : [],
      ...(agentLabel ? { agentLabel } : {})
    }) as unknown as WorkflowStep;

  it("never parents a lane to itself, so every lane stays reachable from the root", () => {
    const layout = createAgentTreeLayout([laneStep("s1", 1), laneStep("s2", 2, "X", "X")]);
    expect(layout.lanes.filter((lane) => lane.parentLaneId === lane.id)).toHaveLength(0);
    const laneX = layout.lanes.find((lane) => lane.label === "X");
    expect(laneX?.parentLaneId).toBe("root");
  });

  it("orders lanes without hanging when spawns cross between two lanes", () => {
    const layout = createAgentTreeLayout([
      laneStep("s1", 1),
      laneStep("s2", 2, "A", "B"),
      laneStep("s3", 3, "B", "A")
    ]);
    expect(layout.lanes.map((lane) => lane.id)).toContain("root");
    expect(layout.lanes.filter((lane) => lane.parentLaneId === lane.id)).toHaveLength(0);
  });
});
