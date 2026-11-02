import { describe, expect, it } from "vitest";

import { createTraceEvent } from "./events.js";
import { dominantCwd, projectKey } from "./projectPath.js";

const ev = (seq: number, cwd?: string) =>
  createTraceEvent(seq, {
    host: "claude-code",
    runId: "r",
    sessionId: "s",
    kind: "file_read",
    payload: { path: "a.ts" } as never,
    ...(cwd ? { cwd } : {})
  });

describe("dominantCwd / projectKey", () => {
  it("picks the most frequent absolute cwd, not the first", () => {
    const events = [ev(1, "/proj/sub/out.dir"), ev(2, "/proj"), ev(3, "/proj"), ev(4, "/proj")];
    expect(dominantCwd(events)).toBe("/proj");
    expect(projectKey(events)).toBe("proj");
  });

  it("ignores relative/odd cwds and returns null when none are absolute", () => {
    expect(dominantCwd([ev(1, "../escape"), ev(2)])).toBeNull();
    expect(projectKey([ev(1)])).toBeNull();
  });

  it("derives a basename key for the project", () => {
    expect(projectKey([ev(1, "/Users/me/work/my-repo"), ev(2, "/Users/me/work/my-repo")])).toBe("my-repo");
    expect(projectKey([ev(1, "/Users/me/work/my-repo/")])).toBe("my-repo"); // trailing slash tolerated
  });

  it.each([
    String.raw`C:\work\my-repo`,
    "C:/work/my-repo",
    String.raw`\\server\share\my-repo`,
    "\\\\server\\share\\my-repo\\",
    String.raw`\\server\my-repo`,
    String.raw`\\?\C:\work\my-repo`,
    String.raw`\\?\UNC\server\share\my-repo`,
    String.raw`\\?\unc\server\my-repo`,
    String.raw`\\.\C:\work\my-repo`,
    String.raw`\\.\UNC\server\share\my-repo`
  ])("preserves Windows absolute project cwd %s", (cwd) => {
    expect(dominantCwd([ev(1, cwd)])).toBe(cwd);
    expect(projectKey([ev(1, cwd)])).toBe("my-repo");
  });

  it.each([
    String.raw`work\my-repo`,
    String.raw`C:my-repo`,
    "C:",
    String.raw`\my-repo`,
    String.raw`\\server`,
    "\\\\server\\",
    String.raw`\\?\C:relative`,
    String.raw`\\?\C:`,
    String.raw`\\?\UNC`,
    String.raw`\\?\UNC\server`,
    "\\\\?\\UNC\\server\\",
    String.raw`\\.\C:relative`,
    String.raw`\\.\UNC\server`
  ])("rejects Windows cwd without an absolute drive or share root: %s", (cwd) => {
    expect(dominantCwd([ev(1, cwd)])).toBeNull();
    expect(projectKey([ev(1, cwd)])).toBeNull();
  });
});
