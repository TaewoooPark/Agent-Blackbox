import { createTraceEvent, type TraceEvent } from "@agent-blackbox/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRulePack, resetRuleCache } from "./ruleStore.js";

const dirs: string[] = [];
afterEach(async () => {
  resetRuleCache();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function projectWithRules(rules: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "abb-rules-"));
  dirs.push(dir);
  await mkdir(join(dir, ".agent-blackbox"), { recursive: true });
  await writeFile(join(dir, ".agent-blackbox", "rules.json"), rules, "utf8");
  return dir;
}

const readIn = (cwd: string): TraceEvent[] => [
  createTraceEvent(1, { host: "claude-code", runId: "r", sessionId: "r", kind: "file_read", payload: { path: "a.ts" } as never, cwd }),
  createTraceEvent(2, { host: "claude-code", runId: "r", sessionId: "r", kind: "file_read", payload: { path: "b.ts" } as never, cwd })
];

describe("loadRulePack", () => {
  it("loads + parses the pack from the run's dominant cwd", async () => {
    const dir = await projectWithRules(JSON.stringify({ rules: [{ id: "x", type: "forbid-read", pattern: "node_modules" }] }));
    const pack = await loadRulePack(readIn(dir), 1000);
    expect(pack.rules.map((r) => r.id)).toEqual(["x"]);
  });

  it("returns an empty pack when there's no cwd to resolve", async () => {
    const noCwd = [createTraceEvent(1, { host: "claude-code", runId: "r", sessionId: "r", kind: "file_read", payload: { path: "a.ts" } as never })];
    expect((await loadRulePack(noCwd, 1000)).rules).toEqual([]);
  });

  it("tolerates a corrupt rules file (empty pack, no throw)", async () => {
    const dir = await projectWithRules("{ not json");
    await expect(loadRulePack(readIn(dir), 1000)).resolves.toEqual({ rules: [] });
  });
});
