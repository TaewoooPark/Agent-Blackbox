import { createTraceEvent, type TraceEvent } from "@agent-blackbox/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runOptimize } from "./optimize.js";

const ev = (
  seq: number,
  runId: string,
  ts: string,
  kind: Parameters<typeof createTraceEvent>[1]["kind"],
  payload: Record<string, unknown>
): TraceEvent => createTraceEvent(seq, { host: "opencode", runId, sessionId: "s", kind, payload: payload as never, ts });

// A wasteful run: the same file read twice then edited → redundant-reads fires.
const wasteful = (runId: string, ts: string) => [
  ev(1, runId, ts, "file_read", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }),
  ev(2, runId, ts, "file_read", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }),
  ev(3, runId, ts, "file_edit", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 100 })
];

let dir = "";
const seed = async (events: TraceEvent[]) => {
  dir = await mkdtemp(join(tmpdir(), "abb-opt-"));
  await mkdir(join(dir, ".agent-blackbox"), { recursive: true });
  await writeFile(join(dir, ".agent-blackbox", "events.ndjson"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
};

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("optimize (AGENTS.md efficiency memory)", () => {
  it("applies a memory block, detects no-new-run on check, and reverts exactly", async () => {
    await seed(wasteful("run-a", "2026-06-01T00:00:00.000Z"));
    const agentsMd = join(dir, "AGENTS.md");

    const applied = await runOptimize({ projectDir: dir, mode: "apply" });
    expect(applied.changed).toBe(true);
    expect(applied.baselineScore).toBeTypeOf("number");
    expect(await readFile(agentsMd, "utf8")).toContain("agent-blackbox:efficiency:start");

    // No new run since apply → must not claim success.
    const checked = await runOptimize({ projectDir: dir, mode: "check" });
    expect(checked.action).toMatch(/no new run/i);

    // Revert removes the file (it did not exist before apply).
    await runOptimize({ projectDir: dir, mode: "revert" });
    await expect(readFile(agentsMd, "utf8")).rejects.toThrow();
  });

  it("appends to an existing AGENTS.md without disturbing the stable prefix", async () => {
    await seed(wasteful("run-a", "2026-06-01T00:00:00.000Z"));
    const agentsMd = join(dir, "AGENTS.md");
    const prefix = "# Project\n\nInstructions the prompt cache depends on.\n";
    await writeFile(agentsMd, prefix, "utf8");

    await runOptimize({ projectDir: dir, mode: "apply" });
    const after = await readFile(agentsMd, "utf8");
    expect(after.startsWith(prefix.trimEnd())).toBe(true);
    expect(after).toContain("agent-blackbox:efficiency:start");

    // Revert restores the original prefix exactly.
    await runOptimize({ projectDir: dir, mode: "revert" });
    expect(await readFile(agentsMd, "utf8")).toBe(prefix);
  });
});
