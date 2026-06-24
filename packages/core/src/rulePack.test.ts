import { describe, expect, it } from "vitest";

import { createTraceEvent } from "./events.js";
import { evaluateRulePack, parseRulePack } from "./rulePack.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "claude-code", runId: "r", sessionId: "s", kind, payload: payload as never });

describe("parseRulePack", () => {
  it("keeps valid rules and drops malformed ones (bad type, bad regex, no id, dup)", () => {
    const pack = parseRulePack({
      rules: [
        { id: "no-vendor", type: "forbid-read", pattern: "node_modules" },
        { id: "bad-regex", type: "forbid-read", pattern: "(" }, // invalid regex → dropped
        { id: "bad-type", type: "nonsense", pattern: "x" }, // unknown type → dropped
        { type: "forbid-bash", pattern: "rm -rf" }, // missing id → dropped
        { id: "no-vendor", type: "forbid-edit", pattern: "x" } // duplicate id → dropped
      ]
    });
    expect(pack.rules.map((r) => r.id)).toEqual(["no-vendor"]);
  });

  it("returns an empty pack for anything unrecognisable", () => {
    expect(parseRulePack(null).rules).toEqual([]);
    expect(parseRulePack({ rules: "nope" }).rules).toEqual([]);
    expect(parseRulePack(42).rules).toEqual([]);
  });
});

describe("evaluateRulePack", () => {
  it("flags forbidden reads and redacts to basenames", () => {
    const pack = parseRulePack({ rules: [{ id: "no-vendor", type: "forbid-read", pattern: "node_modules", message: "Don't read vendored code." }] });
    const findings = evaluateRulePack(
      [
        ev(1, "file_read", { path: "/proj/node_modules/left-pad/index.js", chars: 100 }),
        ev(2, "file_read", { path: "/proj/src/app.ts", chars: 100 })
      ],
      pack
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe("Don't read vendored code.");
    expect(findings[0]!.offenders).toEqual(["index.js"]); // basename only, full path not leaked
  });

  it("flags forbidden bash commands by verb", () => {
    const pack = parseRulePack({ rules: [{ id: "no-force-push", type: "forbid-bash", pattern: "push --force", severity: "bad" }] });
    const findings = evaluateRulePack([ev(1, "bash", { command: "git push --force origin main", exitCode: 0 })], pack);
    expect(findings[0]!.severity).toBe("bad");
    expect(findings[0]!.offenders).toEqual(["git"]);
  });

  it("flags reading a matching file more than the limit", () => {
    const pack = parseRulePack({ rules: [{ id: "config-once", type: "max-reads", pattern: "config\\.json", limit: 1 }] });
    const findings = evaluateRulePack(
      [
        ev(1, "file_read", { path: "/p/config.json", chars: 100 }),
        ev(2, "file_read", { path: "/p/config.json", chars: 100 }),
        ev(3, "file_read", { path: "/p/config.json", chars: 100 })
      ],
      pack
    );
    expect(findings[0]!.offenders[0]).toBe("config.json ×3");
  });

  it("require-before-commit flags a commit with no passing check before it, but not one with", () => {
    const pack = parseRulePack({ rules: [{ id: "test-first", type: "require-before-commit", pattern: "npm test" }] });
    const without = evaluateRulePack([ev(1, "git_commit", { command: "git commit", exitCode: 0 })], pack);
    expect(without).toHaveLength(1);

    const withCheck = evaluateRulePack(
      [
        ev(1, "bash", { command: "npm test", exitCode: 0 }),
        ev(2, "git_commit", { command: "git commit", exitCode: 0 })
      ],
      pack
    );
    expect(withCheck).toHaveLength(0);

    // A FAILING check doesn't satisfy the rule.
    const failed = evaluateRulePack(
      [ev(1, "bash", { command: "npm test", exitCode: 1 }), ev(2, "git_commit", { command: "git commit", exitCode: 0 })],
      pack
    );
    expect(failed).toHaveLength(1);
  });

  it("produces no findings for an empty pack", () => {
    expect(evaluateRulePack([ev(1, "file_read", { path: "x", chars: 1 })], { rules: [] })).toEqual([]);
  });
});
