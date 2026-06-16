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

  it("truncates long command output", () => {
    const result = redactJsonObject({ output: "a".repeat(16) }, { maxStringLength: 5 });

    expect(result.value.output).toBe("aaaaa...[TRUNCATED 11 chars]");
    expect(result.truncated).toBe(true);
    expect(result.rulesApplied).toContain("truncate-string");
  });
});

