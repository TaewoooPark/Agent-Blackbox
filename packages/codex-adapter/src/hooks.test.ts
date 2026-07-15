import { describe, expect, it } from "vitest";
import { codexHookSpecs, hasAbbCodexHooks, mergeAbbCodexHooks, removeAbbCodexHooks, type CodexHooksConfig } from "./hooks.js";

describe("Codex optimizer hook config", () => {
  it("preserves user hooks, installs every ABB hook once, and removes only ABB hooks", () => {
    const config: CodexHooksConfig = {
      model: "gpt-test",
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-policy" }] }] }
    };
    const once = mergeAbbCodexHooks(config, "node /abs/codex-hook.mjs");
    const twice = mergeAbbCodexHooks(once, "node /abs/codex-hook.mjs");
    expect(hasAbbCodexHooks(twice)).toBe(true);
    expect(twice.hooks?.PreToolUse?.find((group) => group.hooks.some((hook) => hook.command.includes("agent-blackbox-codex-hook")))?.matcher).toContain("Bash");
    for (const spec of codexHookSpecs()) {
      const installed = twice.hooks?.[spec.event]?.filter((group) => group.hooks.some((hook) => hook.command.includes("agent-blackbox-codex-hook"))) ?? [];
      expect(installed).toHaveLength(1);
    }
    const cleaned = removeAbbCodexHooks(twice);
    expect(hasAbbCodexHooks(cleaned)).toBe(false);
    expect(cleaned.hooks?.PreToolUse?.some((group) => group.hooks.some((hook) => hook.command === "my-policy"))).toBe(true);
    expect(cleaned.model).toBe("gpt-test");
  });
});
