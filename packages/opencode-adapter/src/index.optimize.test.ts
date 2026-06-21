import { describe, expect, it } from "vitest";

import { createOpenCodeRecorder } from "./index.js";

const recorder = (optimize: boolean) =>
  createOpenCodeRecorder({ directory: "/tmp" }, { optimize, sink: { write: async () => {} }, runId: "t" });

const BIG = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
const readOut = (content: string) => ({ title: "", output: content, metadata: {} });
const readIn = (callID: string) => ({ tool: "read", sessionID: "s", callID, args: { filePath: "a.ts" } });

describe("wired in-run optimizer", () => {
  it("serves no-op/diff re-reads, full again after compaction, and injects the working set", async () => {
    const rec = await recorder(true);
    const after = rec["tool.execute.after"];

    const o1 = readOut(BIG);
    await after(readIn("1"), o1);
    expect(o1.output).toBe(BIG); // first read → full

    const o2 = readOut(BIG);
    await after(readIn("2"), o2);
    expect(o2.output).toMatch(/unchanged/i); // unchanged re-read → no-op
    expect((o2.output as string).length).toBeLessThan(BIG.length / 2);

    const edited = BIG.replace("line 60", "line 60 changed");
    const o3 = readOut(edited);
    await after(readIn("3"), o3);
    expect(o3.output).toContain("line 60 changed"); // edited re-read → diff with the change
    expect((o3.output as string).length).toBeLessThan(edited.length);

    // A compaction may have evicted the content → serve full again (correctness).
    await rec["experimental.session.compacting"]!({}, {});
    const o4 = readOut(edited);
    await after(readIn("4"), o4);
    expect(o4.output).toBe(edited);

    // B: the working-set memory block is injected into the system prompt.
    const sys = { system: ["You are a coding agent."] };
    await rec["experimental.chat.system.transform"]!({}, sys);
    expect(sys.system.join("\n")).toContain("a.ts");
  });

  it("keys reads by window — a windowed read isn't treated as a re-read of the whole file", async () => {
    const rec = await recorder(true);
    const after = rec["tool.execute.after"];
    const whole = readOut(BIG);
    await after({ tool: "read", sessionID: "s", callID: "1", args: { filePath: "a.ts" } }, whole);
    expect(whole.output).toBe(BIG);
    // Same bytes but an explicit offset/limit window → different cache key → served
    // FULL, not collapsed to a wrong "unchanged" no-op against the whole-file copy.
    const windowed = readOut(BIG);
    await after({ tool: "read", sessionID: "s", callID: "2", args: { filePath: "a.ts", offset: 0, limit: 120 } }, windowed);
    expect(windowed.output).toBe(BIG);
  });

  it("is off by default — the recorder stays a pure observer", async () => {
    const rec = await recorder(false);
    const after = rec["tool.execute.after"];
    const o1 = readOut(BIG);
    await after(readIn("1"), o1);
    const o2 = readOut(BIG);
    await after(readIn("2"), o2);
    expect(o2.output).toBe(BIG); // unchanged re-read still served full — no interception
  });
});
