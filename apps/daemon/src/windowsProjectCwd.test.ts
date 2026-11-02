import { createTraceEvent } from "@agent-blackbox/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { expect, it } from "vitest";

import { runOptimize } from "./optimize.js";

it.skipIf(process.platform !== "win32")("optimizes the project's extended-length cwd instead of the daemon directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "abb-namespaced-cwd-"));
  const projectDir = join(root, "project");
  const daemonDir = join(root, "daemon");
  try {
    await mkdir(projectDir);
    await mkdir(join(daemonDir, ".agent-blackbox"), { recursive: true });
    const cwd = toNamespacedPath(projectDir);
    const events = [1, 2].map((seq) => createTraceEvent(seq, {
      host: "codex",
      runId: "windows-project",
      sessionId: "s",
      kind: "file_read",
      cwd,
      payload: { path: "$PROJECT/src/calc.ts", chars: 80_000 },
      ts: "2026-06-01T00:00:00.000Z"
    }));
    await writeFile(join(daemonDir, ".agent-blackbox", "events.ndjson"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    const applied = await runOptimize({ projectDir: daemonDir, mode: "apply" });
    expect(applied.agentsMdPath).toBe(join(cwd, "AGENTS.md"));
    expect(applied.applied).toBe(true);
    expect(await readFile(join(projectDir, "AGENTS.md"), "utf8")).toContain("agent-blackbox:efficiency:start");
    expect(JSON.parse(await readFile(join(projectDir, ".agent-blackbox", "optimization.json"), "utf8"))).toMatchObject({
      runId: "windows-project",
      memoryFile: "AGENTS.md"
    });
    expect(JSON.parse(await readFile(join(projectDir, ".agent-blackbox", "efficiency-profile.json"), "utf8"))).toBeTypeOf("object");
    for (const file of ["AGENTS.md", ".agent-blackbox/optimization.json", ".agent-blackbox/efficiency-profile.json"]) {
      await expect(readFile(join(daemonDir, file), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }

    const reverted = await runOptimize({ projectDir: daemonDir, mode: "revert" });
    expect(reverted.changed).toBe(true);
    expect(reverted.applied).toBe(false);
    await expect(readFile(join(projectDir, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(projectDir, ".agent-blackbox", "optimization.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
