import { describe, expect, it } from "vitest";

import { buildCausalTimeline } from "./timeline.js";
import { createTraceEvent } from "./events.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "claude-code", runId: "r", sessionId: "s", kind, payload: payload as never });

describe("buildCausalTimeline", () => {
  it("tags a re-read with no compaction between as reread (genuine waste)", () => {
    const tl = buildCausalTimeline([
      ev(1, "file_read", { path: "$P/a.ts", chars: 100 }),
      ev(2, "file_read", { path: "$P/a.ts", chars: 100 })
    ]);
    expect(tl.map((t) => t.act)).toEqual(["read", "reread"]);
    expect(tl[1]!.target).toBe("a.ts");
  });

  it("does NOT tag a re-read after a compaction (the window was reset)", () => {
    const tl = buildCausalTimeline([
      ev(1, "file_read", { path: "$P/a.ts", chars: 100 }),
      ev(2, "context_compacted", {}),
      ev(3, "file_read", { path: "$P/a.ts", chars: 100 })
    ]);
    expect(tl.map((t) => t.act)).toEqual(["read", "compact", "read"]); // second read is legitimate
  });

  it("maps the action vocabulary and redacts to basenames/verbs", () => {
    const tl = buildCausalTimeline([
      ev(1, "file_edit", { path: "/abs/src/b.ts", chars: 100 }),
      ev(2, "file_created", { path: "/abs/c.ts", chars: 100 }),
      ev(3, "bash", { command: "npm run build", exitCode: 0 }),
      ev(4, "bash", { command: "grep -r foo /secret/path", exitCode: 0 }),
      ev(5, "host_event", { event: "api_error", level: "error" }),
      ev(6, "subagent_spawned", { agent: "explore", agentId: "x" })
    ]);
    expect(tl.map((t) => `${t.act}${t.target ? ":" + t.target : ""}`)).toEqual([
      "edit:b.ts",
      "create:c.ts",
      "bash:npm",
      "search:grep", // verb only — the path is not leaked
      "error",
      "subagent:explore"
    ]);
  });

  it("caps to the most recent maxEntries", () => {
    const events = Array.from({ length: 60 }, (_, i) => ev(i + 1, "file_read", { path: `$P/f${i}.ts`, chars: 100 }));
    const tl = buildCausalTimeline(events, { maxEntries: 10 });
    expect(tl).toHaveLength(10);
    expect(tl[tl.length - 1]!.target).toBe("f59.ts"); // newest kept
  });
});
