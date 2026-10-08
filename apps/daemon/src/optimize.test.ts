import { createTraceEvent, type TraceEvent } from "@agent-blackbox/core";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isReusableCommand, runOptimize } from "./optimize.js";

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

  it("writes AGENTS.md atomically (temp + rename) — preserves the prefix and leaves no temp file", async () => {
    await seed(wasteful("run-a", "2026-06-01T00:00:00.000Z"));
    const agentsMd = join(dir, "AGENTS.md");
    const prefix = "# Project\n\nUser notes the prompt cache depends on.\n";
    await writeFile(agentsMd, prefix, "utf8");

    await runOptimize({ projectDir: dir, mode: "apply" });
    const after = await readFile(agentsMd, "utf8");
    expect(after.startsWith(prefix.trimEnd())).toBe(true); // user content above the block intact
    expect(after).toContain("agent-blackbox:efficiency:start");
    // The rename must have completed — no orphaned .tmp scratch file left behind.
    expect((await readdir(dir)).some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("ignores a non-absolute (untrusted) cwd and falls back to projectDir", async () => {
    // cwd rides in on POSTed events; a relative/odd value must not redirect the write.
    const events = wasteful("run-evil", "2026-06-01T00:00:00.000Z").map((e) => ({ ...e, cwd: "../../../etc" }));
    await seed(events);
    const applied = await runOptimize({ projectDir: dir, mode: "apply" });
    expect(applied.agentsMdPath).toBe(join(dir, "AGENTS.md")); // fell back, did not escape
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("agent-blackbox:efficiency:start");
  });

  it("writes to the run's DOMINANT cwd, not a transient first one", async () => {
    // A session's first event can carry a transient subdir (e.g. an output folder);
    // the project root — where the bulk of the work ran and the next session reads
    // the memory — must win.
    const projectRoot = await mkdtemp(join(tmpdir(), "abb-root-"));
    const subdir = await mkdtemp(join(tmpdir(), "abb-sub-"));
    try {
      const events = wasteful("run-d", "2026-06-01T00:00:00.000Z").map((e, i) => ({
        ...e,
        cwd: i === 0 ? subdir : projectRoot
      }));
      await seed(events);
      const applied = await runOptimize({ projectDir: dir, mode: "apply" });
      expect(applied.agentsMdPath).toBe(join(projectRoot, "AGENTS.md"));
      await expect(readFile(join(subdir, "AGENTS.md"), "utf8")).rejects.toThrow();
      await runOptimize({ projectDir: dir, mode: "revert" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(subdir, { recursive: true, force: true });
    }
  });

  it("optimizes the requested run, not whichever is globally-latest", async () => {
    // Several sessions at once: the dashboard passes the run it's showing so optimize
    // doesn't act on a different, newer session.
    const older = await mkdtemp(join(tmpdir(), "abb-older-"));
    const newer = await mkdtemp(join(tmpdir(), "abb-newer-"));
    try {
      const events = [
        ...wasteful("run-old", "2026-06-01T00:00:00.000Z").map((e) => ({ ...e, cwd: older })),
        ...wasteful("run-new", "2026-06-02T00:00:00.000Z").map((e) => ({ ...e, cwd: newer }))
      ];
      await seed(events);
      // Default → the globally-latest run.
      expect((await runOptimize({ projectDir: dir, mode: "preview" })).agentsMdPath).toBe(join(newer, "AGENTS.md"));
      // Targeted → the run the caller asked for.
      const targeted = await runOptimize({ projectDir: dir, mode: "apply", runId: "run-old" });
      expect(targeted.agentsMdPath).toBe(join(older, "AGENTS.md"));
      expect(await readFile(join(older, "AGENTS.md"), "utf8")).toContain("agent-blackbox:efficiency:start");
      await expect(readFile(join(newer, "AGENTS.md"), "utf8")).rejects.toThrow();
      await runOptimize({ projectDir: dir, mode: "revert", runId: "run-old" });
    } finally {
      await rm(older, { recursive: true, force: true });
      await rm(newer, { recursive: true, force: true });
    }
  });

  // --- host-aware target file (Claude Code reads CLAUDE.md, Codex/OpenCode AGENTS.md) ---
  const wastefulCC = (runId: string, ts: string) =>
    wasteful(runId, ts).map((e) => ({ ...e, host: "claude-code" as const }));

  it("targets CLAUDE.md for a claude-code run, leaving AGENTS.md untouched", async () => {
    await seed(wastefulCC("cc-run", "2026-06-01T00:00:00.000Z"));
    const claudeMd = join(dir, "CLAUDE.md");

    const applied = await runOptimize({ projectDir: dir, mode: "apply" });
    expect(applied.agentsMdPath).toBe(claudeMd);
    expect(await readFile(claudeMd, "utf8")).toContain("agent-blackbox:efficiency:start");
    await expect(readFile(join(dir, "AGENTS.md"), "utf8")).rejects.toThrow(); // never written for CC

    await runOptimize({ projectDir: dir, mode: "revert" });
    await expect(readFile(claudeMd, "utf8")).rejects.toThrow();
  });

  it("targets AGENTS.md for a Codex run", async () => {
    const codex = wasteful("codex-run", "2026-06-01T00:00:00.000Z").map((e) => ({ ...e, host: "codex" as const }));
    await seed(codex);

    const applied = await runOptimize({ projectDir: dir, mode: "apply" });
    expect(applied.agentsMdPath).toBe(join(dir, "AGENTS.md"));
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("agent-blackbox:efficiency:start");
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });

  it("reverts the file written at apply even when the latest run's host flips", async () => {
    // Apply on a claude-code run → CLAUDE.md.
    const cc = wastefulCC("cc-run", "2026-06-01T00:00:00.000Z");
    await seed(cc);
    await runOptimize({ projectDir: dir, mode: "apply" });
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toContain("agent-blackbox:efficiency:start");

    // A newer opencode run becomes the latest (so host-by-latest would say AGENTS.md).
    const oc = wasteful("oc-run", "2026-06-02T00:00:00.000Z");
    await writeFile(join(dir, ".agent-blackbox", "events.ndjson"), `${[...cc, ...oc].map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

    // revert must still strip from CLAUDE.md, where the block actually lives.
    const reverted = await runOptimize({ projectDir: dir, mode: "revert" });
    expect(reverted.agentsMdPath).toBe(join(dir, "CLAUDE.md"));
    await expect(readFile(join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
  });
});

// The commands below are verbatim from a real 661-event Claude Code run whose
// optimize preview offered all four as "verified commands worth reusing". Each one
// is a one-off: pinning it would add noise to the context of every future run.
describe("verified commands (what earns a place in the memory block)", () => {
  it("pins boolean-only successful commands and excludes failed or unknown results", async () => {
    const ts = "2026-06-01T00:00:00.000Z";
    await seed([
      ...wasteful("run-a", ts),
      ev(10, "run-a", ts, "bash", { command: "npm test", success: true, outputChars: 100 }),
      ev(11, "run-a", ts, "bash", { command: "npm run build", success: false, outputChars: 100 }),
      ev(12, "run-a", ts, "bash", { command: "npm run lint", outputChars: 100 })
    ]);
    await runOptimize({ projectDir: dir, mode: "apply" });
    const block = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(block).toContain("npm test");
    expect(block).not.toContain("npm run build");
    expect(block).not.toContain("npm run lint");
  });

  const REAL_ONE_OFFS = [
    'uv --version 2>&1; echo "---"; gh auth status 2>&1 | head -8',
    "mkdir -p ~/demo && cd ~/demo && git init -b main && git clone --depth 1 ~/src vendor",
    `curl -s -X POST http://127.0.0.1:8800/api/generate -d '{"prompt":"why is the sky blue"}'`,
    "git clone --depth 1 https://github.com/example/repo"
  ];

  it("pins the project's real test command and drops one-off pipelines", async () => {
    const ts = "2026-06-01T00:00:00.000Z";
    const events = [
      ...wasteful("run-a", ts),
      ...REAL_ONE_OFFS.map((command, i) => ev(10 + i, "run-a", ts, "bash", { command, exitCode: 0, outputChars: 100 })),
      ev(20, "run-a", ts, "bash", { command: "npm test", exitCode: 0, outputChars: 100 })
    ];
    await seed(events);

    await runOptimize({ projectDir: dir, mode: "apply" });
    const block = await readFile(join(dir, "AGENTS.md"), "utf8");

    expect(block).toContain("npm test");
    for (const oneOff of REAL_ONE_OFFS) expect(block).not.toContain(oneOff);
    expect(block).not.toContain("git clone");
    expect(block).not.toContain("curl");
  });

  it("accepts build/verify shapes and rejects side effects and one-offs", () => {
    for (const ok of [
      "npm test", "npm run build", "pnpm lint", "go test ./...", "cargo clippy",
      "make", "pytest -q", "npx tsc --noEmit", "bundle exec rspec", "uv run pytest"
    ]) {
      expect(isReusableCommand(ok), ok).toBe(true);
    }
    for (const no of [
      "npm install", "npm run dev", "git clone x", "curl http://x", "mkdir -p x",
      "uv --version", "ls -la", "npm test && git push", "echo hi | grep h",
      `node -e "${"x".repeat(120)}"`
    ]) {
      expect(isReusableCommand(no), no).toBe(false);
    }
  });

  it("never carries a secret from a command line into the committed memory file", async () => {
    const ts = "2026-06-01T00:00:00.000Z";
    await seed([
      ...wasteful("run-a", ts),
      ev(10, "run-a", ts, "bash", { command: "npm test --token=sk-ant-0123456789abcdefghijklmno", exitCode: 0, outputChars: 10 })
    ]);

    await runOptimize({ projectDir: dir, mode: "apply" });
    const block = await readFile(join(dir, "AGENTS.md"), "utf8");
    expect(block).not.toContain("sk-ant-0123456789abcdefghijklmno");
    expect(block).toContain("[REDACTED_ANTHROPIC_KEY]");
  });
});
