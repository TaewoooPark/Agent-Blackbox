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
});
