import { describe, expect, it } from "vitest";
import {
  abbHookSpecs,
  buildWorkingSet,
  bumpGeneration,
  decideRead,
  emptyState,
  hasAbbHooks,
  isReusableCommand,
  mergeAbbHooks,
  recordCommand,
  recordEdit,
  recordRead,
  removeAbbHooks,
  type Settings
} from "./hooks.js";

const INV = "node /abs/hook-entry.js";

describe("settings.json hook merge", () => {
  it("preserves other settings and the user's own hooks while adding ABB's", () => {
    const settings: Settings = {
      model: "claude-opus-4-8",
      permissions: { allow: ["Bash"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }] }
    };
    const next = mergeAbbHooks(settings, INV);
    // Untouched keys survive.
    expect(next.model).toBe("claude-opus-4-8");
    expect(next.permissions).toEqual({ allow: ["Bash"] });
    // The user's own PreToolUse hook is still there, alongside ABB's.
    const pre = next.hooks?.PreToolUse ?? [];
    expect(pre.some((g) => g.hooks.some((h) => h.command === "my-own-linter"))).toBe(true);
    expect(pre.some((g) => g.hooks.some((h) => h.command.includes("agent-blackbox-hook")))).toBe(true);
    // Every spec'd event got an ABB entry.
    for (const spec of abbHookSpecs()) {
      expect((next.hooks?.[spec.event] ?? []).some((g) => g.hooks.some((h) => h.command.includes("agent-blackbox-hook")))).toBe(true);
    }
  });

  it("is idempotent — re-merging re-stamps without piling up duplicates", () => {
    const once = mergeAbbHooks({}, INV);
    const twice = mergeAbbHooks(once, INV);
    for (const spec of abbHookSpecs()) {
      const abbGroups = (twice.hooks?.[spec.event] ?? []).filter((g) => g.hooks.some((h) => h.command.includes("agent-blackbox-hook")));
      expect(abbGroups).toHaveLength(1);
    }
  });

  it("removes only ABB's hooks, leaving the user's intact", () => {
    const settings: Settings = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }] }
    };
    const merged = mergeAbbHooks(settings, INV);
    expect(hasAbbHooks(merged)).toBe(true);
    const cleaned = removeAbbHooks(merged);
    expect(hasAbbHooks(cleaned)).toBe(false);
    expect(cleaned.hooks?.PreToolUse?.some((g) => g.hooks.some((h) => h.command === "my-own-linter"))).toBe(true);
  });

  it("drops the hooks key entirely when only ABB's were present", () => {
    const cleaned = removeAbbHooks(mergeAbbHooks({ model: "x" }, INV));
    expect(cleaned.hooks).toBeUndefined();
    expect(cleaned.model).toBe("x");
  });
});

describe("read-dedup decision", () => {
  it("allows a first read and denies an identical unchanged re-read", () => {
    const state = emptyState();
    expect(decideRead(state, "/p/a.ts", 100).deny).toBe(false);
    recordRead(state, "/p/a.ts", 100);
    const again = decideRead(state, "/p/a.ts", 100);
    expect(again.deny).toBe(true);
    if (again.deny) expect(again.reason).toContain("/p/a.ts");
  });

  it("allows the re-read when the file changed on disk (mtime differs)", () => {
    const state = emptyState();
    recordRead(state, "/p/a.ts", 100);
    expect(decideRead(state, "/p/a.ts", 200).deny).toBe(false);
  });

  it("allows the re-read after a compaction (generation bumped — content may be gone)", () => {
    const state = emptyState();
    recordRead(state, "/p/a.ts", 100);
    bumpGeneration(state);
    expect(decideRead(state, "/p/a.ts", 100).deny).toBe(false);
  });

  it("allows the re-read after the file was edited (the record is cleared)", () => {
    const state = emptyState();
    recordRead(state, "/p/a.ts", 100);
    recordEdit(state, "/p/a.ts");
    expect(decideRead(state, "/p/a.ts", 100).deny).toBe(false);
  });
});

describe("working set", () => {
  it("only pins reusable commands, deduped", () => {
    const state = emptyState();
    recordCommand(state, "ls -la"); // navigation → skipped
    recordCommand(state, "npm test");
    recordCommand(state, "npm test"); // dup → skipped
    recordCommand(state, "cat foo"); // read-only → skipped
    expect(state.commands).toEqual(["npm test"]);
    expect(isReusableCommand("npm run build")).toBe(true);
    expect(isReusableCommand("grep foo")).toBe(false);
  });

  it("is null when nothing happened, and summarizes reads/edits/commands by basename", () => {
    expect(buildWorkingSet(emptyState())).toBeNull();
    const state = emptyState();
    recordRead(state, "/p/src/a.ts", 1);
    recordEdit(state, "/p/src/b.ts");
    recordCommand(state, "npm test");
    const block = buildWorkingSet(state);
    expect(block).toContain("a.ts");
    expect(block).toContain("b.ts");
    expect(block).toContain("npm test");
    expect(block).not.toContain("/p/src/"); // basename only, not full paths
  });

  it("does not list an edited file under 'already read'", () => {
    const state = emptyState();
    recordRead(state, "/p/a.ts", 1);
    recordEdit(state, "/p/a.ts");
    const block = buildWorkingSet(state) ?? "";
    expect(block).toContain("Files edited");
    expect(block).not.toContain("don't re-read unchanged): a.ts");
  });
});
