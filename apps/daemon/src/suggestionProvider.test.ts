import { computeEfficiencyReport, createTraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";

import { buildDigest, generateSuggestions } from "./suggestionProvider.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "opencode", runId: "r", sessionId: "s", kind, payload: payload as never });

// An inefficient run whose directory structure, command arguments, and secrets
// must never reach a model — only leaf basenames and command verbs may, so advice
// can name what to fix ("billing.ts ×2", "deploy ×2").
const report = computeEfficiencyReport([
  ev(1, "file_read", { source: "tool.after", path: "$PROJECT/clients/acme-corp/billing.ts", chars: 80_000 }),
  ev(2, "file_read", { source: "tool.after", path: "$PROJECT/clients/acme-corp/billing.ts", chars: 80_000 }),
  ev(3, "file_edit", { source: "tool.after", path: "$PROJECT/clients/acme-corp/billing.ts", chars: 100 }),
  ev(4, "bash", { source: "tool.after", command: "deploy --token hunter2", exitCode: 1, outputChars: 8000 }),
  ev(5, "bash", { source: "tool.after", command: "deploy --token hunter2", exitCode: 0, outputChars: 200 })
]);

describe("suggestion provider", () => {
  it("redacts the digest — directories, command args, and secrets never leave; only basenames and verbs do", () => {
    const digest = buildDigest(report);
    const json = JSON.stringify(digest);
    // Sensitive parts — directory structure, command arguments, secrets — never leak.
    expect(json).not.toContain("acme-corp");
    expect(json).not.toContain("clients/");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("--token");
    // Low-sensitivity offenders that make advice actionable — leaf basename + command verb.
    expect(json).toContain("billing.ts");
    expect(json).toContain("deploy");
    // only flagged metrics are included
    expect(digest.metrics.length).toBeGreaterThan(0);
    expect(digest.metrics.every((m) => m.status !== "good")).toBe(true);
  });

  it("returns deterministic suggestions when mode is off", async () => {
    const result = await generateSuggestions(report, { mode: "off" });
    expect(result.provider).toBe("deterministic");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.every((s) => s.source === "deterministic")).toBe(true);
  });

  it("falls back to deterministic when the configured provider is unreachable", async () => {
    const result = await generateSuggestions(report, { mode: "ollama", baseUrl: "http://127.0.0.1:9" });
    expect(result.provider).toBe("deterministic");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});
