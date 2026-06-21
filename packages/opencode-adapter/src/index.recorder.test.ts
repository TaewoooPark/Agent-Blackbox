import type { TraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";
import { createOpenCodeRecorder } from "./index.js";

describe("OpenCode recorder hooks", () => {
  it("writes normalized events through the provided sink", async () => {
    const events: TraceEvent[] = [];
    const recorder = await createOpenCodeRecorder(
      { directory: "/repo" },
      {
        runId: "run-hooks",
        sink: {
          async write(event) {
            events.push(event);
          }
        }
      }
    );

    await recorder.event({ event: { type: "session.created", sessionID: "session-hooks" } });
    await recorder["tool.execute.before"]({ tool: "read", sessionID: "session-hooks" }, { args: { filePath: "README.md" } });
    await recorder["tool.execute.after"](
      { tool: "read", sessionID: "session-hooks", args: { filePath: "README.md" } },
      { metadata: { preview: "README" } }
    );

    expect(events.map((event) => event.kind)).toEqual(["session_created", "tool_call", "file_read"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.runId === "run-hooks")).toBe(true);
    expect(events[2]?.payload.path).toBe("README.md");
  });

  it("stamps the project cwd on every event (so the actuator can target it)", async () => {
    const events: TraceEvent[] = [];
    const recorder = await createOpenCodeRecorder(
      { directory: "/repo/my-app" },
      { runId: "run-cwd", sink: { async write(event) { events.push(event); } } }
    );
    await recorder.event({ event: { type: "session.created", sessionID: "s" } });
    expect(events[0]?.cwd).toBe("/repo/my-app");
  });

  it("no-ops entirely when AGENT_BLACKBOX_DISABLE=1 (daemon-spawned runs aren't recorded)", async () => {
    const prev = process.env.AGENT_BLACKBOX_DISABLE;
    process.env.AGENT_BLACKBOX_DISABLE = "1";
    try {
      const events: TraceEvent[] = [];
      const recorder = await createOpenCodeRecorder(
        { directory: "/repo" },
        { runId: "run-disabled", sink: { async write(event) { events.push(event); } } }
      );
      await recorder.event({ event: { type: "session.created", sessionID: "s" } });
      await recorder["tool.execute.after"]({ tool: "read", sessionID: "s", args: { filePath: "a.ts" } }, { metadata: {} });
      expect(events).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.AGENT_BLACKBOX_DISABLE;
      else process.env.AGENT_BLACKBOX_DISABLE = prev;
    }
  });

  it("records the opencode run prompt as a workflow message", async () => {
    const events: TraceEvent[] = [];
    const recorder = await createOpenCodeRecorder(
      { directory: "/repo" },
      {
        cliPrompt: "Fix src/calc.js and run npm test.",
        runId: "run-hooks",
        sink: {
          async write(event) {
            events.push(event);
          }
        }
      }
    );

    await recorder.event({ event: { type: "session.created", sessionID: "session-hooks" } });

    expect(events.map((event) => event.kind)).toEqual(["session_created", "message"]);
    expect(events[1]?.summary).toBe("opencode.run.prompt");
    expect(events[1]?.payload).toMatchObject({
      properties: {
        role: "user",
        text: "Fix src/calc.js and run npm test."
      }
    });
  });

  it("emits the CLI prompt once on the root session, never in subagent sessions", async () => {
    const events: TraceEvent[] = [];
    const recorder = await createOpenCodeRecorder(
      { directory: "/repo" },
      { cliPrompt: "ultrawork: build it", runId: "run-multi", sink: { async write(event) { events.push(event); } } }
    );

    await recorder.event({ event: { type: "session.created", properties: { sessionID: "root", info: { id: "root" } } } });
    await recorder.event({
      event: { type: "session.created", properties: { sessionID: "child", info: { id: "child", parentID: "root", agent: "explore" } } }
    });

    const prompts = events.filter((event) => event.summary === "opencode.run.prompt");
    expect(prompts.length).toBe(1); // not duplicated into the subagent session
    expect(prompts[0]?.sessionId).toBe("root");
  });
});
