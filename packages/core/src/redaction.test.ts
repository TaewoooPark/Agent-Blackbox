import { describe, expect, it } from "vitest";
import { redactJsonObject } from "./redaction.js";

describe("redaction", () => {
  it("redacts common token-like secrets and local home paths", () => {
    const result = redactJsonObject(
      {
        command: "curl -H 'Authorization: Bearer gho_abcdefghijklmnopqrstuvwxyz1234567890'",
        path: "/Users/taewoopark/personal/Agent-Blackbox/packages/core/src/index.ts"
      },
      {
        homeDir: "/Users/taewoopark"
      }
    );

    expect(result.value.command).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(result.value.path).toBe("~/personal/Agent-Blackbox/packages/core/src/index.ts");
    expect(result.rulesApplied).toEqual(["github-token", "home-dir"]);
  });

  it("redacts generic bearer tokens and secret assignments", () => {
    const result = redactJsonObject({
      command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' https://example.test",
      env: "api_key=plainsecretvalue password:anothersecretvalue",
      json: '{"password": "supersecretvalue", "note": "ok"}'
    });

    expect(result.value.command).toContain("Bearer [REDACTED_TOKEN]");
    expect(result.value.env).toContain("api_key=[REDACTED_SECRET]");
    expect(result.value.env).toContain("password=[REDACTED_SECRET]");
    // Quoted JSON values (the common transcript shape) are caught too.
    expect(result.value.json).toContain("password=[REDACTED_SECRET]");
    expect(result.value.json).not.toContain("supersecretvalue");
    expect(result.rulesApplied).toEqual(["bearer-token", "secret-assignment"]);
  });

  it("strips a Windows home/project dir regardless of path separator (no leak on '/' or '\\')", () => {
    // Claude Code on Windows emits both separators for the same dir. Each form must be
    // stripped — otherwise an absolute home path survives in the persisted trace.
    const result = redactJsonObject(
      {
        backslash: "C:\\Users\\rt\\proj\\src\\foo.ts",
        forwardslash: "C:/Users/rt/proj/src/bar.ts",
        homeButNotProject: "C:/Users/rt/other/x.ts"
      },
      { homeDir: "C:\\Users\\rt", projectDir: "C:\\Users\\rt\\proj" }
    );

    expect(result.value.backslash).toBe("$PROJECT\\src\\foo.ts");
    expect(result.value.forwardslash).toBe("$PROJECT/src/bar.ts");
    expect(result.value.homeButNotProject).toBe("~/other/x.ts");
    // Belt-and-suspenders: no raw home path leaks in any field, in any separator form.
    expect(JSON.stringify(result.value)).not.toContain("Users");
  });

  it("truncates long command output", () => {
    const result = redactJsonObject({ output: "a".repeat(16) }, { maxStringLength: 5 });

    expect(result.value.output).toBe("aaaaa...[TRUNCATED 11 chars]");
    expect(result.truncated).toBe(true);
    expect(result.rulesApplied).toContain("truncate-string");
  });

  it("redacts well-formed PEM blocks (single and multiple)", () => {
    const block = (kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----\nMIIBVwIBADANBgkq\n-----END ${kind}PRIVATE KEY-----`;
    const one = redactJsonObject({ key: block("") });
    expect(one.value.key).toBe("[REDACTED_PRIVATE_KEY]");
    expect(one.rulesApplied).toContain("private-key");

    // Two adjacent blocks both redact — tempered quantifier doesn't fuse them.
    const two = redactJsonObject({ keys: `${block("RSA ")}\n${block("EC ")}` });
    expect(two.value.keys).toBe("[REDACTED_PRIVATE_KEY]\n[REDACTED_PRIVATE_KEY]");
  });

  it("does not catastrophically backtrack on many BEGIN markers without an END", () => {
    // Untrusted tool output peppered with BEGIN markers and no END. The old
    // `[\s\S]*?` scanned to end-of-string from every BEGIN — O(n²). The tempered
    // quantifier bounds each scan to the next BEGIN, so this stays linear.
    const hostile = `${"-----BEGIN RSA PRIVATE KEY-----\n".repeat(10_000)}tail`;
    const started = Date.now();
    // High maxStringLength so the regex runs on the full input (the ReDoS path) and
    // isn't masked by post-redaction truncation.
    const result = redactJsonObject({ output: hostile }, { maxStringLength: 10_000_000 });
    expect(Date.now() - started).toBeLessThan(2000); // fixed: ~ms; vulnerable: many seconds
    expect(result.value.output).toBe(hostile); // no END → nothing redacted
    expect(result.rulesApplied).not.toContain("private-key");
  });
});

