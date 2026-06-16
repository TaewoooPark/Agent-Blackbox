import type { TraceEvent } from "./events.js";
import type { WorkflowGraph, WorkflowNode } from "./graph.js";

export type PromiseCheckStatus = "verified" | "unverified" | "contradicted";
export type PromiseCheckSeverity = "info" | "warning" | "risk";

export type PromiseCheck = {
  claim: string;
  status: PromiseCheckStatus;
  evidenceEventIds: string[];
  severity: PromiseCheckSeverity;
};

type ClaimRule = {
  name: string;
  pattern: RegExp;
  verifier: (events: TraceEvent[]) => string[];
  severity: PromiseCheckSeverity;
};

const claimRules: ClaimRule[] = [
  {
    name: "tests-run",
    pattern: /\b(?:ran|run|running|executed)\s+(?:the\s+)?(?:tests?|test suite|checks?)\b/i,
    verifier: (events) =>
      events
        .filter((event) => event.kind === "bash" && stringPayload(event, "command")?.match(/\b(test|check|vitest|pytest|cargo test|npm test)\b/i))
        .map((event) => event.id),
    severity: "warning"
  },
  {
    name: "file-updated",
    pattern: /\b(?:updated|edited|patched|changed|modified)\s+(?:the\s+)?(?:file|code|implementation|readme|docs?)\b/i,
    verifier: (events) => events.filter((event) => event.kind === "file_edit").map((event) => event.id),
    severity: "warning"
  },
  {
    name: "committed",
    pattern: /\b(?:committed|created a commit|made a commit)\b/i,
    verifier: (events) => events.filter((event) => event.kind === "git_commit").map((event) => event.id),
    severity: "risk"
  }
];

export function evaluatePromiseChecks(events: TraceEvent[]): PromiseCheck[] {
  const messageEvents = events.filter((event) => event.kind === "message" && event.evidence.claimedByModel);
  const checks: PromiseCheck[] = [];
  for (const message of messageEvents) {
    const text = stringPayload(message, "text") ?? stringPayload(message, "content") ?? "";
    for (const rule of claimRules) {
      if (!rule.pattern.test(text)) {
        continue;
      }
      const evidenceEventIds = rule.verifier(events);
      checks.push({
        claim: `${rule.name}: ${shorten(text)}`,
        status: evidenceEventIds.length > 0 ? "verified" : "unverified",
        evidenceEventIds,
        severity: evidenceEventIds.length > 0 ? "info" : rule.severity
      });
    }
  }
  return checks;
}

export function generateHandoffMarkdown(graph: WorkflowGraph, checks: PromiseCheck[] = []): string {
  const files = graph.nodes.filter((node) => node.type === "FILE");
  const decisions = graph.nodes.filter((node) => node.type === "DECISION");
  const failures = graph.nodes.filter((node) => node.status === "FAILED");
  const blockers = graph.nodes.filter((node) => node.type === "BLOCKER" || node.status === "BLOCKED");
  const commands = graph.nodes.filter((node) => node.type === "COMMAND");
  return [
    `# Agent-Blackbox Handoff`,
    ``,
    `## Current Objective`,
    `Run: ${graph.runId}`,
    ``,
    `## What Has Been Observed`,
    `- Events applied: ${graph.appliedEventIds.length}`,
    `- Nodes: ${graph.nodes.length}`,
    `- Edges: ${graph.edges.length}`,
    ``,
    `## Files In Play`,
    renderNodeList(files),
    ``,
    `## Decisions`,
    renderNodeList(decisions),
    ``,
    `## Commands / Verification`,
    renderNodeList(commands),
    ``,
    `## Failed Attempts`,
    renderNodeList(failures),
    ``,
    `## Blockers / Approval Needed`,
    renderNodeList(blockers),
    ``,
    `## Promise Checks`,
    checks.length === 0
      ? `- No model claims matched the built-in promise-check rules.`
      : checks
          .map((check) => `- ${check.status.toUpperCase()}: ${check.claim} (${check.evidenceEventIds.join(", ") || "no evidence"})`)
          .join("\n"),
    ``,
    `## Next Safe Action`,
    blockers.length > 0
      ? `Resolve or approve the blocker before continuing.`
      : failures.length > 0
        ? `Inspect the latest failed command or error node before editing again.`
        : `Continue from the latest decision or verification node.`
  ].join("\n");
}

function renderNodeList(nodes: WorkflowNode[]): string {
  if (nodes.length === 0) {
    return "- None recorded.";
  }
  return nodes
    .map((node) => `- ${node.label} [${node.status}] events=${node.eventIds.join(",") || "none"}`)
    .join("\n");
}

function stringPayload(event: TraceEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function shorten(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

