import { eventSucceeded, type TraceEvent } from "./events.js";
import { firstUserPrompt } from "./prompt.js";
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

const TEST_COMMAND = /\b(test|check|vitest|pytest|cargo test|npm test)\b/i;

const claimRules: ClaimRule[] = [
  {
    name: "tests-run",
    pattern: /\b(?:ran|run|running|executed)\s+(?:the\s+)?(?:tests?|test suite|checks?)\b/i,
    verifier: (events) =>
      events
        .filter((event) => event.kind === "bash" && TEST_COMMAND.test(stringPayload(event, "command") ?? ""))
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
    verifier: (events) => events.filter((event) => event.kind === "git_commit" && eventSucceeded(event) !== false).map((event) => event.id),
    severity: "risk"
  }
];

export function evaluatePromiseChecks(events: TraceEvent[]): PromiseCheck[] {
  const messageEvents = events.filter((event) => event.kind === "message" && event.evidence.claimedByModel);
  const checks: PromiseCheck[] = [];
  // A rule's evidence depends only on the events, not on which message made the
  // claim — so resolve it at most once per rule instead of re-scanning the whole
  // event list for every claiming message. This runs on every snapshot, in the
  // daemon AND on the dashboard's render thread, so on a long run the repeated
  // scans (messages × rules × events) were the expensive part of the check.
  const evidenceByRule = new Map<string, string[]>();
  const evidenceFor = (rule: ClaimRule): string[] => {
    const cached = evidenceByRule.get(rule.name);
    if (cached) return cached;
    const resolved = rule.verifier(events);
    evidenceByRule.set(rule.name, resolved);
    return resolved;
  };
  for (const message of messageEvents) {
    const text = stringPayload(message, "text") ?? stringPayload(message, "content") ?? "";
    for (const rule of claimRules) {
      if (!rule.pattern.test(text)) {
        continue;
      }
      const evidenceEventIds = evidenceFor(rule);
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

// This document is pasted into another agent's context, so it is charged for by the
// token on the far side: everything in it has to earn its place. Two rules follow.
// A section with nothing in it is not rendered at all — an empty "Failed Attempts"
// reads as "nothing failed" when it means "not measured", and that is worse than
// silence. And nothing is listed just because it exists: the caps below keep a
// 661-event run's handoff near 1.5k characters instead of the 16k it used to be,
// almost all of which was internal event ids no reader outside this tool can resolve.
const FILE_CAP = 12;
const NODE_CAP = 8;

export function generateHandoffMarkdown(
  graph: WorkflowGraph,
  checks: PromiseCheck[] = [],
  events: TraceEvent[] = []
): string {
  const files = graph.nodes.filter((node) => node.type === "FILE");
  const decisions = graph.nodes.filter((node) => node.type === "DECISION");
  const failures = graph.nodes.filter((node) => node.status === "FAILED");
  const blockers = graph.nodes.filter((node) => node.type === "BLOCKER" || node.status === "BLOCKED");
  // A failed command has its own section below; listing it in both doubles the length
  // of a run that failed a lot, which is exactly the run whose handoff must stay short.
  const commands = graph.nodes.filter((node) => node.type === "COMMAND" && node.status !== "FAILED");
  const objective = firstUserPrompt(events);

  const section = (title: string, body: string | null): string[] => (body ? [`## ${title}`, body, ``] : []);

  return [
    `# Agent-Blackbox Handoff`,
    ``,
    ...section("Current Objective", objective ?? `Not captured in the recorded events (run ${graph.runId}).`),
    ...section(
      "What Has Been Observed",
      `- ${graph.appliedEventIds.length} events · ${graph.nodes.length} nodes · ${files.length} files touched`
    ),
    ...section("Files In Play", renderFiles(files, graph)),
    ...section("Decisions", renderNodeList(decisions)),
    ...section("Commands / Verification", renderNodeList(commands)),
    ...section("Failed Attempts", renderNodeList(failures)),
    ...section("Blockers / Approval Needed", renderNodeList(blockers)),
    ...section(
      "Promise Checks",
      checks.length === 0 ? null : checks.map((check) => `- ${check.status.toUpperCase()}: ${check.claim}`).join("\n")
    ),
    `## Next Safe Action`,
    blockers.length > 0
      ? `Resolve or approve the blocker before continuing.`
      : failures.length > 0
        ? `Inspect the latest failed command or error node before editing again.`
        : commands.length > 0
          ? `Continue from the last verified command; re-run it before trusting the state.`
          : `Continue from the last file touched above.`
  ].join("\n");
}

// "In play" means the run was working on it, so files it changed outrank files it only
// read, and the most recent of each comes first — a truncated list should keep what a
// continuation actually needs.
function renderFiles(files: WorkflowNode[], graph: WorkflowGraph): string | null {
  if (files.length === 0) return null;
  const changed = new Set(
    graph.edges.filter((edge) => edge.type === "EDITS" || edge.type === "CREATES").map((edge) => edge.to)
  );
  const ranked = [...files].reverse().sort((a, b) => Number(changed.has(b.id)) - Number(changed.has(a.id)));
  const shown = ranked
    .slice(0, FILE_CAP)
    .map((node) => `- ${oneLine(node.label)}${changed.has(node.id) ? " [changed]" : ""}`);
  return [...shown, ...(files.length > FILE_CAP ? [`- …and ${files.length - FILE_CAP} more`] : [])].join("\n");
}

function renderNodeList(nodes: WorkflowNode[]): string | null {
  if (nodes.length === 0) return null;
  const shown = nodes.slice(-NODE_CAP).map((node) => `- ${oneLine(node.label)} [${node.status}]`);
  return [...shown, ...(nodes.length > NODE_CAP ? [`- …and ${nodes.length - NODE_CAP} earlier`] : [])].join("\n");
}

// Capping the number of entries is not enough on its own: a COMMAND node's label is
// the command, and a command can be a whole multi-line shell script. Eight of those
// ran a "Failed Attempts" section to 7,280 characters over 102 lines on a real run.
// What a continuation needs is which command failed, not its body — so each entry is
// one line, clipped.
const LABEL_MAX = 110;

function oneLine(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

function stringPayload(event: TraceEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function shorten(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}
