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

  it("detects a new run by timestamp even when the runId is reused", async () => {
    const first = wasteful("pinned", "2026-06-01T00:00:00.000Z");
    await seed(first);
    await runOptimize({ projectDir: dir, mode: "apply" });

    // A second run that reused the same runId (e.g. AGENT_BLACKBOX_RUN_ID pinned), newer ts.
    const second = [
      ev(11, "pinned", "2026-06-02T00:00:00.000Z", "file_read", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }),
      ev(12, "pinned", "2026-06-02T00:00:00.000Z", "file_read", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }),
      ev(13, "pinned", "2026-06-02T00:00:00.000Z", "file_edit", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 100 })
    ];
    await writeFile(
      join(dir, ".agent-blackbox", "events.ndjson"),
      `${[...first, ...second].map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8"
    );
    const checked = await runOptimize({ projectDir: dir, mode: "check" });
    expect(checked.action).not.toMatch(/no new run/i); // newer ts → treated as a new run despite same runId
  });

  it("on check, reports which metric cleared and keeps the memory on improvement", async () => {
    const first = wasteful("r1", "2026-06-01T00:00:00.000Z"); // redundant-reads flagged
    await seed(first);
    await runOptimize({ projectDir: dir, mode: "apply" });

    // A cleaner, newer run (a single edit, no re-reads) → redundant-reads clears.
    const second = [ev(20, "r2", "2026-06-02T00:00:00.000Z", "file_edit", { source: "tool.after", path: "$PROJECT/a.ts", chars: 200 })];
    await writeFile(
      join(dir, ".agent-blackbox", "events.ndjson"),
      `${[...first, ...second].map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8"
    );
    const checked = await runOptimize({ projectDir: dir, mode: "check" });
    expect(checked.action).toMatch(/cleared.*redundant-reads/i);
    expect(checked.action).toMatch(/kept/i);
    expect(checked.changed).toBe(false);
  });

  it("revert strips only the managed block, preserving edits made above it", async () => {
    await seed(wasteful("r", "2026-06-01T00:00:00.000Z"));
    const agentsMd = join(dir, "AGENTS.md");
    await writeFile(agentsMd, "# Project\n\nOriginal note.\n", "utf8");
    await runOptimize({ projectDir: dir, mode: "apply" });

    // The user adds a note above the managed block after apply.
    const applied = await readFile(agentsMd, "utf8");
    await writeFile(agentsMd, applied.replace("Original note.", "Original note.\n\nUser added this later."), "utf8");

    await runOptimize({ projectDir: dir, mode: "revert" });
    const final = await readFile(agentsMd, "utf8");
    expect(final).toContain("User added this later."); // concurrent edit preserved
    expect(final).not.toContain("agent-blackbox:efficiency:start"); // our block removed
  });

  it("targets the run's cwd, not the daemon's projectDir (global recorder mode)", async () => {
    // Global mode: one daemon records many projects, so its projectDir is a shared
    // data dir. Events carry cwd = the real project; the actuator must write there.
    const projectRoot = await mkdtemp(join(tmpdir(), "abb-realproj-"));
    try {
      const events = wasteful("run-g", "2026-06-01T00:00:00.000Z").map((e) => ({ ...e, cwd: projectRoot }));
      await seed(events); // `dir` is the daemon's data dir, distinct from projectRoot

      const applied = await runOptimize({ projectDir: dir, mode: "apply" });
      expect(applied.agentsMdPath).toBe(join(projectRoot, "AGENTS.md"));
      expect(await readFile(join(projectRoot, "AGENTS.md"), "utf8")).toContain("agent-blackbox:efficiency:start");
      // Nothing written to the daemon's own dir.
      await expect(readFile(join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();

      // State + revert also resolve to the run's project.
      await runOptimize({ projectDir: dir, mode: "revert" });
      await expect(readFile(join(projectRoot, "AGENTS.md"), "utf8")).rejects.toThrow();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
