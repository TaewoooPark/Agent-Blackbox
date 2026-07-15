import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexHook } from "./hook-entry.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Codex optimizer hook runtime", () => {
  it("denies only an unchanged full-file reread and resets after compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "abb-codex-hook-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const before = process.env.TMPDIR;
    process.env.TMPDIR = root;
    cleanups.push(async () => {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    });

    await writeFile(join(root, "input.txt"), "hook-check\n", "utf8");
    const input = {
      session_id: "hook-runtime-test",
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "cat input.txt" }
    };

    runCodexHook("SessionStart", input);
    expect(runCodexHook("PreToolUse", input)).toBeUndefined();
    runCodexHook("PostToolUse", input);
    expect(runCodexHook("PreToolUse", input)).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" }
    });
    expect(runCodexHook("UserPromptSubmit", input)).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit" }
    });
    runCodexHook("PreCompact", input);
    expect(runCodexHook("PreToolUse", input)).toBeUndefined();
  });
});
