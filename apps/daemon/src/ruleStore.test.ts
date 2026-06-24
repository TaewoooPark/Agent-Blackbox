import { createTraceEvent, type TraceEvent } from "@agent-blackbox/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRulePacks, resetRuleCache } from "./ruleStore.js";

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

describe("loadRulePacks", () => {
  it("keys each project's pack by its cwd basename, so the viewed run can pick its own", async () => {
    const dir = await projectWithRules(JSON.stringify({ rules: [{ id: "x", type: "forbid-read", pattern: "node_modules" }] }));
    const key = dir.split("/").pop()!;
    const packs = await loadRulePacks(readIn(dir), 1000);
    expect(packs[key]?.rules.map((r: { id: string }) => r.id)).toEqual(["x"]);
  });

  it("scopes packs per project — project B's rules don't leak to project A", async () => {
    const a = await projectWithRules(JSON.stringify({ rules: [{ id: "a-rule", type: "forbid-read", pattern: "secrets" }] }));
    const b = await projectWithRules(JSON.stringify({ rules: [{ id: "b-rule", type: "forbid-edit", pattern: "dist" }] }));
    // Window dominated by project B's events, but A's run is still present.
    const events = [...readIn(b), ...readIn(b), ...readIn(a)];
    const packs = await loadRulePacks(events, 1000);
    expect(packs[a.split("/").pop()!]?.rules.map((r: { id: string }) => r.id)).toEqual(["a-rule"]);
    expect(packs[b.split("/").pop()!]?.rules.map((r: { id: string }) => r.id)).toEqual(["b-rule"]);
  });

  it("omits projects with no/empty/corrupt rules and never throws", async () => {
    expect(await loadRulePacks([createTraceEvent(1, { host: "claude-code", runId: "r", sessionId: "r", kind: "file_read", payload: { path: "a.ts" } as never })], 1000)).toEqual({});
    const bad = await projectWithRules("{ not json");
    await expect(loadRulePacks(readIn(bad), 1000)).resolves.toEqual({});
  });
});
