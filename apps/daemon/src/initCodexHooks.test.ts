import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codexHooksPath, installCodexHooks, uninstallCodexHooks } from "./initCodexHooks.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("Codex hook installation", () => {
  it("respects CODEX_HOME and preserves user hooks", async () => {
    const before = process.env.CODEX_HOME;
    const root = await mkdtemp(join(tmpdir(), "abb-codex-hooks-"));
    process.env.CODEX_HOME = root;
    cleanups.push(async () => {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
      await rm(root, { recursive: true, force: true });
    });
    const path = codexHooksPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mine" }] }] } }), "utf8");
    expect((await installCodexHooks({ hookEntryPath: "/tmp/codex hook.mjs" })).hooksPath).toBe(path);
    const installed = JSON.parse(await readFile(path, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(installed.hooks.PreToolUse?.some((group) => group.hooks.some((hook) => hook.command === "mine"))).toBe(true);
    expect(installed.hooks.UserPromptSubmit?.some((group) => group.hooks.some((hook) => hook.command.includes("agent-blackbox-codex-hook")))).toBe(true);
    expect((await uninstallCodexHooks()).removed).toBe(true);
    const cleaned = await readFile(path, "utf8");
    expect(cleaned).toContain("mine");
    expect(cleaned).not.toContain("agent-blackbox-codex-hook");
  });

  it("refuses to overwrite malformed hooks.json", async () => {
    const before = process.env.CODEX_HOME;
    const root = await mkdtemp(join(tmpdir(), "abb-codex-hooks-bad-"));
    process.env.CODEX_HOME = root;
    cleanups.push(async () => {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(root, "hooks.json"), "{bad", "utf8");
    await expect(installCodexHooks({ hookEntryPath: "/tmp/hook.mjs" })).rejects.toThrow("Refusing to edit");
  });
});
