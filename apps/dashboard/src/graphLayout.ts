import type { TraceEvent, WorkflowGraph, WorkflowNode } from "@agent-blackbox/core";

export type PositionedNode = WorkflowNode & {
  x: number;
  y: number;
};

export type DashboardSummary = {
  runId: string;
  nodes: number;
  edges: number;
  events: number;
  activeAgents: number;
  failures: number;
  decisions: number;
};

export type TimelineTone = "neutral" | "work" | "decision" | "risk" | "claim";

export type TimelineMark = {
  id: string;
  seq: number;
  kind: string;
  label: string;
  tone: TimelineTone;
};

export type WorkflowStepKind = "context" | "change" | "verification" | "decision" | "risk" | "coordination";

export type WorkflowBranchKind = "file" | "verification" | "decision" | "risk" | "agent" | "evidence";

export type WorkflowBranch = {
  id: string;
  eventId: string;
  seq: number;
  ts: string;
  kind: WorkflowBranchKind;
  label: string;
  title: string;
  description: string;
  tone: TimelineTone;
  detail?: string;
};

export type WorkflowStep = {
  id: string;
  eventId: string;
  seq: number;
  ts: string;
  kind: WorkflowStepKind;
  title: string;
  description: string;
  tone: TimelineTone;
  branches: WorkflowBranch[];
  agentLabel?: string;
};

const laneByType: Record<string, number> = {
  RUN: 0,
  SESSION: 0,
  AGENT: 1,
  TURN: 2,
  TOOL_CALL: 3,
  COMMAND: 4,
  SEARCH: 4,
  FILE: 5,
  ARTIFACT: 5,
  DECISION: 6,
  BLOCKER: 7,
  ERROR: 7,
  PERMISSION_GATE: 7,
  MESSAGE: 8,
  TODO: 8,
  HANDOFF: 8,
  HYPOTHESIS: 8
};

export function summarizeGraph(graph: WorkflowGraph): DashboardSummary {
  return {
    runId: graph.runId,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    events: graph.appliedEventIds.length,
    activeAgents: graph.nodes.filter((node) => node.type === "AGENT" && node.status === "ACTIVE").length,
    failures: graph.nodes.filter((node) => node.status === "FAILED").length,
    decisions: graph.nodes.filter((node) => node.type === "DECISION").length
  };
}

export function layoutGraphNodes(graph: WorkflowGraph): PositionedNode[] {
  const ordered = [...graph.nodes].sort((a, b) => {
    const laneDelta = (laneByType[a.type] ?? 8) - (laneByType[b.type] ?? 8);
    if (laneDelta !== 0) return laneDelta;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
  const laneCounts = new Map<number, number>();
  return ordered.map((node) => {
    const lane = laneByType[node.type] ?? 8;
    const index = laneCounts.get(lane) ?? 0;
    laneCounts.set(lane, index + 1);
    return {
      ...node,
      x: 32 + index * 184,
      y: 24 + lane * 82
    };
  });
}

export function createTimelineMarks(events: TraceEvent[]): TimelineMark[] {
  return events.map((event) => ({
    id: event.id,
    seq: event.seq,
    kind: event.kind,
    label: summarizeTraceEvent(event),
    tone: toneForEvent(event)
  }));
}

export function summarizeTraceEvent(event: TraceEvent): string {
  const visible = visibleTextForEvent(event);
  if (visible) return visible;
  if (event.summary && !looksLikeCommand(event.summary)) return cleanSummary(event.summary);
  return friendlyFallbackForEvent(event);
}

export function createWorkflowSteps(events: TraceEvent[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let pendingBranches: WorkflowBranch[] = [];

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const branch = contextualBranchForEvent(event, steps.length === 0);
    if (branch) {
      if (branch.kind === "agent" && steps.length > 0) {
        steps[steps.length - 1]!.branches.push(branch);
      } else {
        pendingBranches.push(branch);
      }
      continue;
    }

    const step = trunkStepForEvent(event);
    if (!step) continue;
    step.branches.unshift(...pendingBranches);
    pendingBranches = [];
    steps.push(step);
  }

  if (pendingBranches.length > 0) {
    const target = steps.at(-1);
    if (target) {
      target.branches.push(...pendingBranches);
    } else {
      const firstBranch = pendingBranches[0]!;
      steps.push({
        id: `step-${firstBranch.eventId}`,
        eventId: firstBranch.eventId,
        seq: firstBranch.seq,
        ts: firstBranch.ts,
        kind: "context",
        title: "Gathered context",
        description: "Read and coordination events were collected before a change step appeared.",
        tone: firstBranch.tone,
        branches: pendingBranches
      });
    }
  }

  return steps;
}

function trunkStepForEvent(event: TraceEvent): WorkflowStep | undefined {
  const path = stringPayload(event, "path") ?? stringPayload(event, "file");
  if (path && event.kind === "file_edit") {
    return makeStep(event, {
      kind: "change",
      title: "Changed a file",
      description: `${path} was modified as part of the current task.`,
      branches: [
        makeBranch(event, {
          kind: "file",
          label: path,
          title: "Changed a file",
          description: `${path} was modified as part of the current task.`,
          tone: "work",
          detail: "modified"
        })
      ]
    });
  }
  if (path && event.kind === "file_created") {
    return makeStep(event, {
      kind: "change",
      title: "Created a file",
      description: `${path} was added to the workspace.`,
      branches: [
        makeBranch(event, {
          kind: "file",
          label: path,
          title: "Created a file",
          description: `${path} was added to the workspace.`,
          tone: "work",
          detail: "created"
        })
      ]
    });
  }
  if (path && event.kind === "file_deleted") {
    return makeStep(event, {
      kind: "change",
      title: "Deleted a file",
      description: `${path} was removed from the workspace.`,
      branches: [
        makeBranch(event, {
          kind: "file",
          label: path,
          title: "Deleted a file",
          description: `${path} was removed from the workspace.`,
          tone: "risk",
          detail: "removed"
        })
      ]
    });
  }
  if (event.kind === "bash") {
    const purpose = describeCommandPurpose(
      stringPayload(event, "command"),
      stringPayload(event, "description")
    );
    const outcome = describeCommandOutcome(numberPayload(event, "exitCode"));
    return makeStep(event, {
      kind: outcome.tone === "risk" ? "risk" : "verification",
      title: outcome.titleFor(purpose.shortName),
      description: `${purpose.sentence} ${outcome.sentence}`,
      branches: [
        makeBranch(event, {
          kind: "verification",
          label: outcome.branchLabel,
          title: outcome.titleFor(purpose.shortName),
          description: `${purpose.sentence} ${outcome.sentence}`,
          tone: outcome.tone,
          detail: purpose.shortName
        })
      ]
    });
  }
  const statement = stringPayload(event, "statement");
  if (statement && event.kind === "decision_extracted") {
    return makeStep(event, {
      kind: "decision",
      title: "Made a decision",
      description: cleanSummary(statement),
      branches: [
        makeBranch(event, {
          kind: "decision",
          label: "Decision",
          title: "Made a decision",
          description: cleanSummary(statement),
          tone: "decision",
          detail: cleanSummary(statement)
        })
      ]
    });
  }
  if (event.kind === "blocker_detected" || event.kind === "session_error" || event.kind === "permission_asked") {
    return makeStep(event, {
      kind: "risk",
      title: riskTitleForEvent(event),
      description: riskDescriptionForEvent(event),
      branches: [
        makeBranch(event, {
          kind: "risk",
          label: "Needs attention",
          title: riskTitleForEvent(event),
          description: riskDescriptionForEvent(event),
          tone: "risk"
        })
      ]
    });
  }
  if (event.kind === "session_created" && !event.parentSessionId) {
    return makeStep(event, {
      kind: "coordination",
      title: "Started a session",
      description: "A new agent run began and started collecting workflow evidence.",
      branches: [
        makeBranch(event, {
          kind: "agent",
          label: event.host,
          title: "Started a session",
          description: "A new agent run began and started collecting workflow evidence.",
          tone: "neutral",
          detail: "root"
        })
      ]
    });
  }
  if (event.kind === "git_commit") {
    return makeStep(event, {
      kind: "change",
      title: "Recorded a commit",
      description: "The current set of changes was captured in Git.",
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: "Git commit",
          title: "Recorded a commit",
          description: "The current set of changes was captured in Git.",
          tone: "work"
        })
      ]
    });
  }
  if (event.kind === "git_push") {
    return makeStep(event, {
      kind: "change",
      title: "Pushed changes",
      description: "The latest committed work was pushed to the remote repository.",
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: "Remote updated",
          title: "Pushed changes",
          description: "The latest committed work was pushed to the remote repository.",
          tone: "work"
        })
      ]
    });
  }
  if (event.kind === "handoff_generated") {
    return makeStep(event, {
      kind: "decision",
      title: "Prepared a handoff",
      description: "A concise handoff note was generated from the observed workflow.",
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: "Handoff",
          title: "Prepared a handoff",
          description: "A concise handoff note was generated from the observed workflow.",
          tone: "decision"
        })
      ]
    });
  }
  return undefined;
}

function contextualBranchForEvent(event: TraceEvent, treeIsEmpty: boolean): WorkflowBranch | undefined {
  const path = stringPayload(event, "path") ?? stringPayload(event, "file");
  if (path && event.kind === "file_read") {
    return makeBranch(event, {
      kind: "file",
      label: path,
      title: "Read a file",
      description: `${path} was brought into context.`,
      tone: "work",
      detail: "read into context"
    });
  }
  if (event.kind === "search") {
    return makeBranch(event, {
      kind: "evidence",
      label: "Search",
      title: "Searched for context",
      description: "The agent searched for supporting context before the next main action.",
      tone: "work"
    });
  }
  if (event.kind === "agent_start" || event.kind === "subagent_spawned") {
    return makeBranch(event, {
      kind: "agent",
      label: event.agentId ?? event.agentRole ?? "agent",
      title: event.kind === "subagent_spawned" ? "Started a subagent branch" : "Started an agent lane",
      description: "A parallel agent lane was attached to the workflow tree.",
      tone: "neutral",
      detail: event.kind === "subagent_spawned" ? "subagent" : "agent"
    });
  }
  if (event.kind === "session_created" && (event.parentSessionId || !treeIsEmpty)) {
    return makeBranch(event, {
      kind: "agent",
      label: event.agentId ?? event.agentRole ?? event.sessionId,
      title: "Started a parallel session",
      description: "A separate session was attached as a branch instead of becoming the main trunk.",
      tone: "neutral",
      detail: event.parentSessionId ? "child session" : "session"
    });
  }
  return undefined;
}

export function visibleEventsForGraph(events: TraceEvent[], graph: WorkflowGraph): TraceEvent[] {
  const visibleIds = new Set(graph.appliedEventIds);
  return events.filter((event) => visibleIds.has(event.id));
}

function makeStep(
  event: TraceEvent,
  input: {
    kind: WorkflowStepKind;
    title: string;
    description: string;
    branches: WorkflowBranch[];
  }
): WorkflowStep {
  return {
    id: `step-${event.id}`,
    eventId: event.id,
    seq: event.seq,
    ts: event.ts,
    kind: input.kind,
    title: input.title,
    description: input.description,
    tone: toneForEvent(event),
    branches: input.branches,
    ...(event.agentId || event.agentRole ? { agentLabel: event.agentId ?? event.agentRole } : {})
  };
}

function makeBranch(
  event: TraceEvent,
  input: {
    kind: WorkflowBranchKind;
    label: string;
    title: string;
    description: string;
    tone: TimelineTone;
    detail?: string;
  }
): WorkflowBranch {
  return {
    id: `branch-${event.id}-${input.kind}`,
    eventId: event.id,
    seq: event.seq,
    ts: event.ts,
    kind: input.kind,
    label: input.label,
    title: input.title,
    description: input.description,
    tone: input.tone,
    ...(input.detail ? { detail: input.detail } : {})
  };
}

function visibleTextForEvent(event: TraceEvent): string | undefined {
  const path = stringPayload(event, "path") ?? stringPayload(event, "file");
  if (path && event.kind === "file_read") return `Read ${path}`;
  if (path && event.kind === "file_edit") return `Changed ${path}`;
  if (path && event.kind === "file_created") return `Created ${path}`;
  if (path && event.kind === "file_deleted") return `Deleted ${path}`;
  if (event.kind === "bash") {
    const purpose = describeCommandPurpose(
      stringPayload(event, "command"),
      stringPayload(event, "description")
    );
    const outcome = describeCommandOutcome(numberPayload(event, "exitCode"));
    return outcome.titleFor(purpose.shortName);
  }
  const statement = stringPayload(event, "statement");
  if (statement && event.kind === "decision_extracted") return `Decided: ${shorten(cleanSummary(statement))}`;
  if (event.kind === "blocker_detected" || event.kind === "session_error" || event.kind === "permission_asked") {
    return riskTitleForEvent(event);
  }
  if (event.kind === "session_created") return "Started a session";
  if (event.kind === "agent_start" || event.kind === "subagent_spawned") return "Started an agent lane";
  if (event.kind === "git_commit") return "Recorded a commit";
  if (event.kind === "git_push") return "Pushed changes";
  if (event.kind === "handoff_generated") return "Prepared a handoff";
  return undefined;
}

function describeCommandPurpose(command: string | undefined, description: string | undefined) {
  const source = `${command ?? ""} ${description ?? ""}`.toLowerCase();
  const readableDescription = naturalDescription(description);
  if (/\b(test|vitest|jest|pytest|playwright|spec)\b/.test(source)) {
    return {
      shortName: "tests",
      sentence: readableDescription ?? "The test suite was checked."
    };
  }
  if (/\b(typecheck|tsc|typescript)\b/.test(source)) {
    return {
      shortName: "type check",
      sentence: readableDescription ?? "TypeScript types were checked."
    };
  }
  if (/\b(build|vite build|webpack|rollup)\b/.test(source)) {
    return {
      shortName: "build",
      sentence: readableDescription ?? "The project build was checked."
    };
  }
  if (/\b(lint|eslint|biome)\b/.test(source)) {
    return {
      shortName: "lint",
      sentence: readableDescription ?? "Code style and lint rules were checked."
    };
  }
  if (/\b(git status|git diff|git show)\b/.test(source)) {
    return {
      shortName: "Git review",
      sentence: readableDescription ?? "Repository state was inspected."
    };
  }
  if (/\b(rg|sed|cat|ls|find|grep)\b/.test(source)) {
    return {
      shortName: "file inspection",
      sentence: readableDescription ?? "Project files were inspected."
    };
  }
  if (/\b(install|npm i|pnpm i|yarn add)\b/.test(source)) {
    return {
      shortName: "dependency setup",
      sentence: readableDescription ?? "Dependencies were prepared."
    };
  }
  return {
    shortName: "local task",
    sentence: readableDescription ?? "A local workspace task was run."
  };
}

function describeCommandOutcome(exitCode: number | undefined): {
  branchLabel: string;
  sentence: string;
  tone: TimelineTone;
  titleFor: (purpose: string) => string;
} {
  if (exitCode === undefined) {
    return {
      branchLabel: "Observed",
      sentence: "The result was recorded for the workflow.",
      tone: "work",
      titleFor: (purpose) => `Ran ${purpose}`
    };
  }
  if (exitCode === 0) {
    return {
      branchLabel: "Passed",
      sentence: "It completed successfully.",
      tone: "work",
      titleFor: (purpose) => `${capitalize(purpose)} passed`
    };
  }
  return {
    branchLabel: "Failed",
    sentence: "It failed, so the workflow should connect a later change back to this result.",
    tone: "risk",
    titleFor: (purpose) => `${capitalize(purpose)} failed`
  };
}

function riskTitleForEvent(event: TraceEvent): string {
  if (event.kind === "permission_asked") return "Permission was needed";
  if (event.kind === "session_error") return "The session hit an error";
  return "A blocker was found";
}

function riskDescriptionForEvent(event: TraceEvent): string {
  const text =
    stringPayload(event, "message") ??
    stringPayload(event, "error") ??
    stringPayload(event, "reason") ??
    stringPayload(event, "description") ??
    event.summary;
  return text ? cleanSummary(text) : "The workflow needs attention before this step can be considered resolved.";
}

function friendlyFallbackForEvent(event: TraceEvent): string {
  if (event.kind === "tool_call") return "Started a tool action";
  if (event.kind === "tool_result") return "Recorded a tool result";
  if (event.kind === "search") return "Searched the workspace";
  if (event.kind === "git_status") return "Checked Git state";
  if (event.kind === "permission_replied") return "Resolved a permission request";
  if (event.kind === "todo_updated") return "Updated the task list";
  if (event.kind === "turn_start") return "Started a turn";
  if (event.kind === "turn_end") return "Finished a turn";
  if (event.kind === "agent_end") return "Finished an agent lane";
  if (event.kind === "session_updated") return "Updated the session";
  if (event.kind === "session_idle") return "Session became idle";
  return event.kind.replace(/_/g, " ");
}

function toneForEvent(event: TraceEvent): TimelineTone {
  if (event.kind === "decision_extracted" || event.kind === "handoff_generated") return "decision";
  if (event.kind === "message" && event.evidence.claimedByModel) return "claim";
  if (
    event.kind === "session_error" ||
    event.kind === "blocker_detected" ||
    event.kind === "permission_asked" ||
    (event.kind === "bash" && numberPayload(event, "exitCode") !== undefined && numberPayload(event, "exitCode") !== 0)
  ) {
    return "risk";
  }
  if (
    event.kind === "tool_call" ||
    event.kind === "tool_result" ||
    event.kind === "file_read" ||
    event.kind === "file_edit" ||
    event.kind === "bash" ||
    event.kind === "search"
  ) {
    return "work";
  }
  return "neutral";
}

function stringPayload(event: TraceEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function numberPayload(event: TraceEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" ? value : undefined;
}

function shorten(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function cleanSummary(value: string): string {
  return shorten(value.replace(/\s+/g, " ").trim());
}

function naturalDescription(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const summary = cleanSummary(value);
  if (looksLikeCommand(summary)) return undefined;
  return ensureSentence(summary);
}

function looksLikeCommand(value: string): boolean {
  return /\b(npm|pnpm|yarn|bun|node|npx|git|rg|sed|cat|ls|find|grep|python|pytest|vitest|tsc)\b|&&|\|\||[~$]/
    .test(value.toLowerCase());
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
