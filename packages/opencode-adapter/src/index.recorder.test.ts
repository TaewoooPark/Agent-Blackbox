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
});
