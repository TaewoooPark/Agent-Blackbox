import { computeEfficiencyReport, createTraceEvent } from "@agent-blackbox/core";
import { describe, expect, it } from "vitest";

import { buildDigest, generateSuggestions } from "./suggestionProvider.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "opencode", runId: "r", sessionId: "s", kind, payload: payload as never });

// An inefficient run whose raw paths / commands must never reach a model.
const report = computeEfficiencyReport([
  ev(1, "file_read", { source: "tool.after", path: "$PROJECT/secret-file.ts", chars: 80_000 }),
  ev(2, "file_read", { source: "tool.after", path: "$PROJECT/secret-file.ts", chars: 80_000 }),
  ev(3, "file_edit", { source: "tool.after", path: "$PROJECT/secret-file.ts", chars: 100 }),
  ev(4, "bash", { source: "tool.after", command: "deploy --token hunter2", exitCode: 1, outputChars: 8000 }),
  ev(5, "bash", { source: "tool.after", command: "deploy --token hunter2", exitCode: 0, outputChars: 200 })
]);

describe("suggestion provider", () => {
  it("redacts the digest — no file paths, commands, or secrets leave the process", () => {
    const digest = buildDigest(report);
    const json = JSON.stringify(digest);
    expect(json).not.toContain("secret-file");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("deploy");
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
