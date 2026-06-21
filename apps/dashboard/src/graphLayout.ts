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

export type TimelineTone = "neutral" | "work" | "decision" | "risk" | "claim" | "success";

export type TimelineMark = {
  id: string;
  seq: number;
  kind: string;
  label: string;
  tone: TimelineTone;
};

export type TokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type WorkflowStepKind = "prompt" | "context" | "change" | "verification" | "decision" | "risk" | "coordination";

export type WorkflowBranchKind = "file" | "verification" | "decision" | "risk" | "agent" | "evidence" | "prompt";

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
  tokens: TokenUsage;
  branches: WorkflowBranch[];
  agentLabel?: string; // the lane identity (agentId) — used for matching, not display
  agentName?: string; // human-readable lane name for display only
  agentRole?: string;
};

export type AgentTreeLane = {
  id: string;
  label: string;
  column: number;
  parentLaneId: string | null;
  anchorStepId: string | null;
  startBranch: WorkflowBranch | null;
  steps: WorkflowStep[];
};

export type AgentTreeStepItem = {
  id: string;
  type: "step";
  column: number;
  row: number;
  laneId: string;
  step: WorkflowStep;
};

export type AgentTreeStartItem = {
  id: string;
  type: "agent-start";
  column: number;
  row: number;
  laneId: string;
  branch: WorkflowBranch;
};

export type AgentTreeItem = AgentTreeStepItem | AgentTreeStartItem;

export type AgentTreeConnectionKind = "trunk" | "branch" | "lane";

export type AgentTreeConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: AgentTreeConnectionKind;
  laneId: string;
  eventId: string;
};

export type AgentTreeLayout = {
  lanes: AgentTreeLane[];
  items: AgentTreeItem[];
  connections: AgentTreeConnection[];
  columnCount: number;
  rowCount: number;
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
  return events
    .filter(isWorkflowTimelineEvent)
    .map((event) => ({
      id: event.id,
      seq: event.seq,
      kind: event.kind,
      label: summarizeTraceEvent(event),
      tone: toneForEvent(event)
    }));
}

export function summarizeTraceEvent(event: TraceEvent): string {
  const prompt = promptTextForEvent(event);
  if (prompt) return shorten(prompt);
  const visible = visibleTextForEvent(event);
  if (visible) return visible;
  if (event.summary && !looksLikeCommand(event.summary)) return cleanSummary(event.summary);
  return friendlyFallbackForEvent(event);
}

export function createWorkflowSteps(events: TraceEvent[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let pendingBranches: WorkflowBranch[] = [];
  let pendingTokens = emptyTokenUsage();
  const previousTokenSnapshots = new Map<string, TokenUsage>();
  const seenPrompts = new Set<string>();

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const tokenSnapshot = tokenUsageForEvent(event);
    const previousTokenSnapshot = previousTokenSnapshots.get(event.sessionId);
    const tokenDelta = tokenSnapshot
      ? previousTokenSnapshot
        ? subtractTokenUsage(tokenSnapshot, previousTokenSnapshot)
        : tokenSnapshot
      : emptyTokenUsage();
    if (tokenSnapshot) {
      previousTokenSnapshots.set(event.sessionId, tokenSnapshot);
    }

    const promptStep = promptStepForEvent(event);
    const skipTitlePrompt = promptStep && event.kind !== "message" && seenPrompts.size > 0;
    if (promptStep && !skipTitlePrompt && !seenPrompts.has(promptStep.description)) {
      seenPrompts.add(promptStep.description);
      promptStep.branches.unshift(...pendingBranches);
      promptStep.tokens = addTokenUsage(promptStep.tokens, addTokenUsage(pendingTokens, tokenDelta));
      pendingBranches = [];
      pendingTokens = emptyTokenUsage();
      steps.push(promptStep);
      continue;
    }

    const branch = contextualBranchForEvent(event, steps.length === 0);
    if (branch) {
      if (tokenDelta.total > 0) {
        pendingTokens = addTokenUsage(pendingTokens, tokenDelta);
      }
      if (branch.kind === "agent" && steps.length > 0) {
        steps[steps.length - 1]!.branches.push(branch);
      } else if (branch.kind === "file" && event.agentRole === "subagent") {
        // A subagent's reads are its own work — surface them as steps on the
        // subagent's lane (makeStep tags agentLabel) instead of folding them
        // into the primary trunk. Consecutive reads aggregate into "Read N files".
        steps.push(
          makeStep(event, {
            kind: "context",
            title: "Read a file",
            description: branch.description,
            branches: [branch]
          })
        );
      } else {
        pendingBranches.push(branch);
      }
      continue;
    }

    const step = trunkStepForEvent(event);
    if (step) {
      const previousStep = steps.at(-1);
      if (shouldMergeSequentialStep(previousStep, step, event)) {
        previousStep.branches.push(...pendingBranches);
        mergeFileStepInto(previousStep, step);
        previousStep.tokens = addTokenUsage(previousStep.tokens, addTokenUsage(pendingTokens, tokenDelta));
        pendingBranches = [];
        pendingTokens = emptyTokenUsage();
        continue;
      }
      step.branches.unshift(...pendingBranches);
      step.tokens = addTokenUsage(step.tokens, addTokenUsage(pendingTokens, tokenDelta));
      pendingBranches = [];
      pendingTokens = emptyTokenUsage();
      steps.push(step);
      continue;
    }

    if (tokenDelta.total > 0) {
      const target = steps.at(-1);
      if (target) {
        target.tokens = addTokenUsage(target.tokens, tokenDelta);
      } else {
        pendingTokens = addTokenUsage(pendingTokens, tokenDelta);
      }
    }
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
        tokens: pendingTokens,
        branches: pendingBranches
      });
    }
  }

  return aggregateConsecutiveSteps(steps);
}

// Collapse a run of identical consecutive moments (e.g. 12 sequential
// "Created a file" steps) into one node so a large run stays scannable. The
// first step keeps its seq, so replay reveals the node at the right moment and
// its branch count fills in progressively as the slider advances.
function aggregateConsecutiveSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const result: WorkflowStep[] = [];
  for (const step of steps) {
    const previous = result.at(-1);
    if (previous && canAggregateSteps(previous, step)) {
      previous.branches.push(...step.branches);
      previous.tokens = addTokenUsage(previous.tokens, step.tokens);
      continue;
    }
    result.push({ ...step, branches: [...step.branches] });
  }
  return result;
}

function canAggregateSteps(previous: WorkflowStep, next: WorkflowStep): boolean {
  if (previous.kind !== next.kind) return false;
  if (previous.title !== next.title) return false;
  if (previous.agentLabel !== next.agentLabel) return false;
  if (previous.kind === "coordination") {
    // Collapse repeated identical coordination moments ("Used grep" ×6, "Updated
    // the task list" ×3). The title guard above already keeps differently-named
    // actions (and the unique session start) apart.
    return true;
  }
  return previous.kind === "change" || previous.kind === "verification" || previous.kind === "context";
}

export function filterWorkflowStepsBySeq(steps: WorkflowStep[], replaySeq: number): WorkflowStep[] {
  return steps
    .filter((step) => step.seq <= replaySeq)
    .map((step) => ({
      ...step,
      branches: step.branches.filter((branch) => branch.seq <= replaySeq)
    }));
}

export function createAgentTreeLayout(steps: WorkflowStep[]): AgentTreeLayout {
  const lanes = new Map<string, AgentTreeLane>();
  const rootLane: AgentTreeLane = {
    id: "root",
    label: "main",
    column: 1,
    parentLaneId: null,
    anchorStepId: null,
    startBranch: null,
    steps: []
  };
  lanes.set(rootLane.id, rootLane);

  const ensureLane = (label: string): AgentTreeLane => {
    const id = agentLaneId(label);
    const existing = lanes.get(id);
    if (existing) return existing;
    const lane: AgentTreeLane = {
      id,
      label,
      column: 1,
      parentLaneId: "root",
      anchorStepId: null,
      startBranch: null,
      steps: []
    };
    lanes.set(id, lane);
    return lane;
  };

  for (const step of steps) {
    const lane = step.agentLabel ? ensureLane(step.agentLabel) : rootLane;
    lane.steps.push(step);

    for (const branch of step.branches) {
      if (branch.kind !== "agent" || branch.detail === "root") continue;
      const branchLane = ensureLane(branch.label);
      if (!branchLane.startBranch || branch.seq < branchLane.startBranch.seq) {
        branchLane.startBranch = branch;
        branchLane.anchorStepId = step.id;
        branchLane.parentLaneId = step.agentLabel ? agentLaneId(step.agentLabel) : "root";
      }
    }
  }

  for (const lane of lanes.values()) {
    if (lane.id === "root" || lane.anchorStepId || lane.steps.length === 0) continue;
    const firstStep = lane.steps[0]!;
    const anchor = latestStepBefore(steps, firstStep.seq, firstStep.agentLabel) ?? rootLane.steps[0] ?? null;
    lane.anchorStepId = anchor?.id ?? null;
    lane.parentLaneId = anchor?.agentLabel ? agentLaneId(anchor.agentLabel) : "root";
  }

  const branchLanes = orderBranchLanesByGenealogy(lanes);
  branchLanes.forEach((lane, index) => {
    lane.column = index + 2;
  });

  type PendingTreeItem =
    | (Omit<AgentTreeStepItem, "row"> & { seq: number; priority: number })
    | (Omit<AgentTreeStartItem, "row"> & { seq: number; priority: number });
  const pendingItems: PendingTreeItem[] = [];
  for (const step of rootLane.steps) {
    pendingItems.push({
      id: treeStepNodeId(step.id),
      type: "step",
      column: rootLane.column,
      laneId: rootLane.id,
      step,
      seq: step.seq,
      priority: 1
    });
  }
  for (const lane of branchLanes) {
    if (lane.startBranch) {
      pendingItems.push({
        id: treeStartNodeId(lane.startBranch.id),
        type: "agent-start",
        column: lane.column,
        laneId: lane.id,
        branch: lane.startBranch,
        seq: lane.startBranch.seq,
        priority: 0
      });
    }
    for (const step of lane.steps) {
      pendingItems.push({
        id: treeStepNodeId(step.id),
        type: "step",
        column: lane.column,
        laneId: lane.id,
        step,
        seq: step.seq,
        priority: 1
      });
    }
  }

  const items = pendingItems
    .sort((a, b) => a.seq - b.seq || a.priority - b.priority || a.column - b.column || a.id.localeCompare(b.id))
    .map((item, index): AgentTreeItem => {
      const { seq: _seq, priority: _priority, ...rest } = item;
      return { ...rest, row: index + 1 } as AgentTreeItem;
    });

  const connections: AgentTreeConnection[] = [];
  const rootStepItems = items.filter((item): item is AgentTreeStepItem => item.type === "step" && item.laneId === "root");
  connections.push(...sequentialTreeConnections(rootStepItems, "trunk"));

  for (const lane of branchLanes) {
    const laneItems = items.filter((item) => item.laneId === lane.id);
    const firstItem = laneItems[0];
    if (lane.anchorStepId && firstItem) {
      connections.push({
        id: `tree-edge-${lane.anchorStepId}-${firstItem.id}`,
        fromNodeId: treeStepNodeId(lane.anchorStepId),
        toNodeId: firstItem.id,
        kind: "branch",
        laneId: lane.id,
        eventId: lane.startBranch?.eventId ?? (firstItem.type === "step" ? firstItem.step.eventId : firstItem.branch.eventId)
      });
    }
    connections.push(...sequentialTreeConnections(laneItems, "lane"));
  }

  return {
    lanes: [rootLane, ...branchLanes],
    items,
    connections,
    columnCount: Math.max(1, lanes.size),
    rowCount: Math.max(1, items.length)
  };
}

function latestStepBefore(steps: WorkflowStep[], seq: number, excludedAgentLabel: string | undefined): WorkflowStep | undefined {
  return [...steps]
    .filter((step) => step.seq <= seq && step.agentLabel !== excludedAgentLabel)
    .sort((a, b) => b.seq - a.seq)[0];
}

function laneStartSeq(lane: AgentTreeLane): number {
  return lane.startBranch?.seq ?? lane.steps[0]?.seq ?? Number.MAX_SAFE_INTEGER;
}

function orderBranchLanesByGenealogy(lanes: Map<string, AgentTreeLane>): AgentTreeLane[] {
  const childrenByParent = new Map<string, AgentTreeLane[]>();
  for (const lane of lanes.values()) {
    if (lane.id === "root") continue;
    const parent = lane.parentLaneId ?? "root";
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(lane);
    childrenByParent.set(parent, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => laneStartSeq(a) - laneStartSeq(b) || a.label.localeCompare(b.label));
  }

  const ordered: AgentTreeLane[] = [];
  const visit = (parentId: string) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      ordered.push(child);
      visit(child.id);
    }
  };
  visit("root");

  const included = new Set(ordered.map((lane) => lane.id));
  for (const lane of [...lanes.values()]
    .filter((candidate) => candidate.id !== "root" && !included.has(candidate.id))
    .sort((a, b) => laneStartSeq(a) - laneStartSeq(b) || a.label.localeCompare(b.label))) {
    ordered.push(lane);
  }
  return ordered;
}

function sequentialTreeConnections(
  items: AgentTreeItem[],
  kind: Exclude<AgentTreeConnectionKind, "branch">
): AgentTreeConnection[] {
  const connections: AgentTreeConnection[] = [];
  for (let index = 0; index < items.length - 1; index += 1) {
    const from = items[index]!;
    const to = items[index + 1]!;
    connections.push({
      id: `tree-edge-${from.id}-${to.id}`,
      fromNodeId: from.id,
      toNodeId: to.id,
      kind,
      laneId: from.laneId,
      eventId: to.type === "step" ? to.step.eventId : to.branch.eventId
    });
  }
  return connections;
}

function agentLaneId(label: string): string {
  return `agent:${label}`;
}

function treeStepNodeId(stepId: string): string {
  return `tree-step-${stepId}`;
}

function treeStartNodeId(branchId: string): string {
  return `tree-start-${branchId}`;
}

function promptStepForEvent(event: TraceEvent): WorkflowStep | undefined {
  const prompt = promptTextForEvent(event);
  if (!prompt) return undefined;
  return makeStep(event, {
    kind: "prompt",
    title: "Prompt received",
    description: prompt,
    branches: [
      makeBranch(event, {
        kind: "prompt",
        label: "User prompt",
        title: "Prompt received",
        description: prompt,
        tone: "decision"
      }),
      ...fileMentionsFromText(prompt).map((path) =>
        makeBranch(event, {
          kind: "file",
          label: path,
          title: "Mentioned a file",
          description: `The prompt mentioned ${path}.`,
          tone: "work",
          detail: "mentioned"
        })
      )
    ]
  });
}

function trunkStepForEvent(event: TraceEvent): WorkflowStep | undefined {
  const path = filePathForEvent(event);
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
  if (event.kind === "tool_result") {
    // Tolerate both the clean adapter payload ({tool, skill, source}) and the
    // older raw shape ({tool, phase:"after", input:{args:{name}}}) so runs
    // captured before the skill mapping landed still render.
    const tool = stringPayloadPath(event, ["tool", "input.tool", "output.tool"]);
    if (tool === "skill") {
      const name = stringPayloadPath(event, ["skill", "input.args.name", "output.args.name"]);
      return makeStep(event, {
        kind: "coordination",
        title: name ? `Used the ${name} skill` : "Used a skill",
        description: name ? `The ${name} skill was loaded into the workflow.` : "A skill was loaded into the workflow.",
        branches: [
          makeBranch(event, {
            kind: "evidence",
            label: name ?? "skill",
            title: "Skill",
            description: name ? `The ${name} skill was loaded.` : "A skill was loaded.",
            tone: "decision",
            detail: "skill"
          })
        ]
      });
    }
    if (tool) {
      const note = stringPayloadPath(event, ["description", "input.args.description", "output.metadata.description"]);
      return makeStep(event, {
        kind: "coordination",
        title: `Used ${tool}`,
        description: note ?? `The ${tool} tool was used.`,
        branches: [
          makeBranch(event, {
            kind: "evidence",
            label: tool,
            title: `Used ${tool}`,
            description: note ?? `The ${tool} tool was used.`,
            tone: "work",
            detail: "tool"
          })
        ]
      });
    }
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
  if (event.kind === "permission_replied") {
    const response = stringPayloadPath(event, ["properties.response", "properties.granted", "response"]);
    const denied = response ? /(reject|deny|denied|^no$|false)/i.test(response) : false;
    const description = response
      ? `A pending permission request was resolved (${response}).`
      : "A pending permission request was resolved.";
    return makeStep(event, {
      kind: denied ? "risk" : "decision",
      title: "Resolved a permission request",
      description,
      branches: [
        makeBranch(event, {
          kind: denied ? "risk" : "decision",
          label: "Permission",
          title: "Resolved a permission request",
          description,
          tone: denied ? "risk" : "decision"
        })
      ]
    });
  }
  if (event.kind === "todo_updated") {
    const todos = payloadPath(event, "properties.todos") ?? payloadPath(event, "properties.info.todos");
    const count = Array.isArray(todos) ? todos.length : undefined;
    const description =
      count !== undefined
        ? `The agent revised its plan — ${count} ${count === 1 ? "item" : "items"}.`
        : "The agent revised its task list.";
    return makeStep(event, {
      kind: "coordination",
      title: "Updated the task list",
      description,
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: count !== undefined ? `${count} ${count === 1 ? "item" : "items"}` : "Task list",
          title: "Updated the task list",
          description,
          tone: "neutral",
          detail: "todo"
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
          label: hostDisplayName(event.host),
          title: "Started a session",
          description: "A new agent run began and started collecting workflow evidence.",
          tone: "neutral",
          detail: "root"
        })
      ]
    });
  }
  if (event.kind === "context_compacted") {
    return makeStep(event, {
      kind: "context",
      title: "Context compacted",
      description: "Older turns were summarized and the context window was reset to free space.",
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: "Compaction",
          title: "Context compacted",
          description: "Older turns were summarized and the context window was reset to free space.",
          tone: "decision",
          detail: "compaction"
        })
      ]
    });
  }
  if (event.kind === "command_run") {
    const name = slashCommandName(event);
    return makeStep(event, {
      kind: "coordination",
      title: `Ran ${name}`,
      description: `The ${name} command was invoked.`,
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: name,
          title: `Ran ${name}`,
          description: `The ${name} command was invoked.`,
          tone: "neutral",
          detail: "command"
        })
      ]
    });
  }
  if (event.kind === "agent_switched") {
    const name = switchedAgentName(event);
    return makeStep(event, {
      kind: "coordination",
      title: `Switched to ${name}`,
      description: `The active agent changed to ${name}.`,
      branches: [
        makeBranch(event, {
          kind: "agent",
          label: name,
          title: `Switched to ${name}`,
          description: `The active agent changed to ${name}.`,
          tone: "neutral",
          detail: "agent"
        })
      ]
    });
  }
  if (event.kind === "model_switched") {
    const name = switchedModelName(event);
    return makeStep(event, {
      kind: "coordination",
      title: `Switched model to ${name}`,
      description: `The model changed to ${name}.`,
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label: name,
          title: `Switched model to ${name}`,
          description: `The model changed to ${name}.`,
          tone: "neutral",
          detail: "model"
        })
      ]
    });
  }
  if (event.kind === "host_event") {
    const label = hostEventLabel(event);
    const hostName = hostDisplayName(event.host);
    return makeStep(event, {
      kind: "context",
      title: `${hostName}: ${label}`,
      description: `A ${hostName} event (${label}) that isn't specifically modeled yet — shown so nothing is silently dropped.`,
      branches: [
        makeBranch(event, {
          kind: "evidence",
          label,
          title: `${hostName}: ${label}`,
          description: `Unmodeled ${hostName} event: ${label}.`,
          tone: "neutral",
          detail: "event"
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
  const path = filePathForEvent(event);
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
  // A subagent's own session.created is already represented by the
  // subagent_spawned moment from the task tool, so don't add a second card.
  if (event.kind === "session_created" && event.agentRole !== "subagent" && (event.parentSessionId || !treeIsEmpty)) {
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
    tokens: emptyTokenUsage(),
    branches: input.branches,
    ...(event.agentRole !== "primary" && (event.agentId || event.agentRole)
      ? { agentLabel: event.agentId ?? event.agentRole }
      : {}),
    ...(event.agentRole !== "primary" && event.agentLabel ? { agentName: event.agentLabel } : {}),
    ...(event.agentRole ? { agentRole: event.agentRole } : {})
  };
}

function isWorkflowTimelineEvent(event: TraceEvent): boolean {
  if (promptTextForEvent(event)) return true;
  if (visibleTextForEvent(event)) return true;
  return event.kind === "session_idle" || event.kind === "agent_end";
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
    id: `branch-${event.id}-${input.kind}-${stableIdPart(input.label)}${input.detail ? `-${stableIdPart(input.detail)}` : ""}`,
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

function stableIdPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/^\$project\/?/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

function visibleTextForEvent(event: TraceEvent): string | undefined {
  const path = filePathForEvent(event);
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
  if (event.kind === "context_compacted") return "Context compacted";
  if (event.kind === "command_run") return `Ran ${slashCommandName(event)}`;
  if (event.kind === "agent_switched") return `Switched to ${switchedAgentName(event)}`;
  if (event.kind === "model_switched") return `Switched model to ${switchedModelName(event)}`;
  if (event.kind === "host_event") return `${hostDisplayName(event.host)}: ${hostEventLabel(event)}`;
  return undefined;
}

function promptTextForEvent(event: TraceEvent): string | undefined {
  // OpenCode nests under properties.*; Claude Code puts role/text at the payload top
  // level. Read both so a prompt renders regardless of host.
  const role =
    stringPayloadPath(event, ["properties.role"]) ??
    stringPayloadPath(event, ["properties.info.role"]) ??
    stringPayloadPath(event, ["role"]);
  const text =
    stringPayloadPath(event, ["properties.text"]) ??
    stringPayloadPath(event, ["properties.content"]) ??
    stringPayloadPath(event, ["properties.prompt"]) ??
    stringPayloadPath(event, ["properties.part.text"]) ??
    stringPayloadPath(event, ["properties.part.content"]) ??
    stringPayloadPath(event, ["text"]);
  if (event.kind === "message" && role === "user" && text) {
    return cleanPromptText(text);
  }

  const title = stringPayloadPath(event, ["properties.info.title"]);
  if ((event.kind === "session_created" || event.kind === "session_updated") && title && !isDefaultSessionTitle(title)) {
    return cleanPromptText(title);
  }
  return undefined;
}

function cleanPromptText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > 1600 ? `${normalized.slice(0, 1597)}...` : normalized;
}

function isDefaultSessionTitle(value: string): boolean {
  return /^new session\b/i.test(value.trim());
}

function fileMentionsFromText(value: string): string[] {
  const mentions = new Set<string>();
  for (const match of value.matchAll(/(?:\$PROJECT\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:json|yaml|html|[cm]?[jt]sx?|md|css|py|go|rs|java|kt|swift|rb|php|yml|toml)/g)) {
    const path = match[0];
    if (!path.includes("/") && !/^(package\.json|README\.md)$/i.test(path)) continue;
    const normalized = normalizeMentionPath(path);
    if (normalized) mentions.add(normalized);
  }
  return [...mentions].sort((a, b) => a.localeCompare(b));
}

function normalizeMentionPath(raw: string): string | undefined {
  const withoutPrefix = raw.startsWith("$PROJECT/") ? raw.slice("$PROJECT/".length) : raw;
  const segments = withoutPrefix.split("/").filter((segment) => segment.length > 0);
  // A relative mention from prompt text ("./foo.js", "../foo.js") can't be
  // resolved to a project location, so it would render as a stray "." folder.
  // Drop these instead of inventing a phantom node.
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return `$PROJECT/${segments.join("/")}`;
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
      tone: "success",
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
  if (event.kind === "bash" && numberPayload(event, "exitCode") === 0) {
    return "success";
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

// The slash command name from a `command.executed` event, normalized to "/name".
function slashCommandName(event: TraceEvent): string {
  const raw = stringPayloadPath(event, ["properties.name", "name"]);
  if (!raw) return "a command";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function switchedAgentName(event: TraceEvent): string {
  return stringPayloadPath(event, ["properties.agent", "agent"]) ?? "an agent";
}

function switchedModelName(event: TraceEvent): string {
  return (
    // OpenCode nests model under properties.*; Claude Code puts it at payload.model.
    stringPayloadPath(event, ["properties.model.id", "properties.model.modelID", "properties.modelID", "model.id", "model"]) ??
    "a model"
  );
}

// A labeled fallback for host events we don't model yet (summary holds the raw type).
function hostEventLabel(event: TraceEvent): string {
  return event.summary || stringPayloadPath(event, ["type", "properties.type"]) || "event";
}

// Human-facing name for the recording host, so labels read "Claude Code: …" not
// "claude-code: …" and never assume OpenCode.
export function hostDisplayName(host: TraceEvent["host"] | undefined): string {
  switch (host) {
    case "claude-code":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    case "codex":
      return "Codex";
    case "pi":
      return "PI";
    case "hermes":
      return "Hermes";
    default:
      return "Host";
  }
}

function filePathForEvent(event: TraceEvent): string | undefined {
  return stringPayloadPath(event, [
    "path",
    "file",
    "properties.file",
    "properties.path",
    "output.metadata.path",
    "input.args.filePath",
    "input.args.path"
  ]);
}

export type AgentActivity = {
  moments: number;
  commands: number;
  files: string[];
};

// Summarize what one agent actually did from the raw events (by agentId), so a
// subagent's reads — which the trunk attributes to the parent step — are still
// counted against the agent that performed them.
export function summarizeAgentActivity(events: TraceEvent[], agentLabel: string): AgentActivity {
  const actionKinds = new Set<TraceEvent["kind"]>([
    "file_read",
    "file_edit",
    "file_created",
    "file_deleted",
    "bash"
  ]);
  const actions = events.filter((event) => event.agentId === agentLabel && actionKinds.has(event.kind));
  const files = [...new Set(actions.map((event) => filePathForEvent(event)).filter((path): path is string => Boolean(path)))];
  const commands = actions.filter((event) => event.kind === "bash").length;
  return { commands, files, moments: actions.length };
}

function shouldMergeSequentialStep(
  previousStep: WorkflowStep | undefined,
  nextStep: WorkflowStep,
  event: TraceEvent
): previousStep is WorkflowStep {
  if (!previousStep) return false;
  if (previousStep.kind !== "change" || nextStep.kind !== "change") return false;
  if (previousStep.agentLabel !== nextStep.agentLabel) return false;
  if (event.kind !== "file_edit" && event.kind !== "file_created" && event.kind !== "file_deleted") return false;
  if (nextStep.seq - previousStep.seq > 5) return false;

  // Match on the file path(s) alone, ignoring detail: a write produces both a
  // filesystem-watcher "file.edited" (Changed a file) and a tool.after
  // "file_created" (Created a file) for the same path. They must collapse into
  // one moment even though their titles differ.
  const previousPaths = changedFilePaths(previousStep);
  const nextPaths = changedFilePaths(nextStep);
  if (previousPaths.length === 0 || previousPaths !== nextPaths) return false;

  // Merge only when the redundant watcher event is involved on either side, or
  // when the same tool action repeats for the same file.
  if (isFileWatcherFileEvent(event)) return true;
  if (isToolAfterFileEvent(event)) {
    return previousStep.title === nextStep.title || previousStep.title === "Changed a file";
  }
  return false;
}

// Fold nextStep's file branches into previousStep, deduped by path, and promote
// the moment's title to the most specific action (Created/Deleted beats Changed).
function mergeFileStepInto(previousStep: WorkflowStep, nextStep: WorkflowStep): void {
  if (changeTitleRank(nextStep.title) > changeTitleRank(previousStep.title)) {
    previousStep.title = nextStep.title;
    previousStep.description = nextStep.description;
  }
  for (const branch of nextStep.branches) {
    if (branch.kind === "file") {
      const existing = previousStep.branches.find((entry) => entry.kind === "file" && entry.label === branch.label);
      if (existing) {
        if (branch.detail !== undefined && fileDetailStrength(branch.detail) > fileDetailStrength(existing.detail)) {
          existing.detail = branch.detail;
          existing.title = branch.title;
          existing.description = branch.description;
        }
        continue;
      }
    }
    previousStep.branches.push(branch);
  }
}

function changeTitleRank(title: string): number {
  if (title === "Created a file" || title === "Deleted a file") return 2;
  if (title === "Changed a file") return 1;
  return 0;
}

function fileDetailStrength(detail: string | undefined): number {
  if (detail === "created" || detail === "removed") return 2;
  if (detail === "modified") return 1;
  return 0;
}

function isToolAfterFileEvent(event: TraceEvent): boolean {
  return stringPayload(event, "source") === "tool.after";
}

function isFileWatcherFileEvent(event: TraceEvent): boolean {
  return stringPayloadPath(event, ["type"]) === "file.edited";
}

function changedFilePaths(step: WorkflowStep): string {
  return step.branches
    .filter(
      (branch) =>
        branch.kind === "file" &&
        (branch.detail === "modified" || branch.detail === "created" || branch.detail === "removed")
    )
    .map((branch) => branch.label)
    .sort()
    .join("|");
}

function numberPayload(event: TraceEvent, key: string): number | undefined {
  const value = event.payload[key];
  return typeof value === "number" ? value : undefined;
}

function stringPayloadPath(event: TraceEvent, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = payloadPath(event, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function numberPayloadPath(event: TraceEvent, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = payloadPath(event, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function payloadPath(event: TraceEvent, path: string): unknown {
  let current: unknown = event.payload;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function tokenUsageForEvent(event: TraceEvent): TokenUsage | undefined {
  const hasTokenSnapshot =
    payloadPath(event, "properties.info.tokens") !== undefined ||
    payloadPath(event, "tokens") !== undefined ||
    payloadPath(event, "properties.tokens") !== undefined;
  if (!hasTokenSnapshot) return undefined;

  const usage = {
    input: numberPayloadPath(event, ["properties.info.tokens.input", "properties.tokens.input", "tokens.input"]) ?? 0,
    output: numberPayloadPath(event, ["properties.info.tokens.output", "properties.tokens.output", "tokens.output"]) ?? 0,
    reasoning:
      numberPayloadPath(event, ["properties.info.tokens.reasoning", "properties.tokens.reasoning", "tokens.reasoning"]) ?? 0,
    cacheRead:
      numberPayloadPath(event, [
        "properties.info.tokens.cache.read",
        "properties.tokens.cache.read",
        "tokens.cache.read",
        "properties.info.tokens.cacheRead",
        "properties.tokens.cacheRead",
        "tokens.cacheRead"
      ]) ?? 0,
    cacheWrite:
      numberPayloadPath(event, [
        "properties.info.tokens.cache.write",
        "properties.tokens.cache.write",
        "tokens.cache.write",
        "properties.info.tokens.cacheWrite",
        "properties.tokens.cacheWrite",
        "tokens.cacheWrite"
      ]) ?? 0,
    total: 0
  };
  return normalizeTokenUsage(usage);
}

function emptyTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0
  };
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return normalizeTokenUsage({
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: 0
  });
}

function subtractTokenUsage(current: TokenUsage, previous: TokenUsage): TokenUsage {
  return normalizeTokenUsage({
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    reasoning: Math.max(0, current.reasoning - previous.reasoning),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    total: 0
  });
}

function normalizeTokenUsage(usage: Omit<TokenUsage, "total"> & { total: number }): TokenUsage {
  const input = Math.max(0, Math.round(usage.input));
  const output = Math.max(0, Math.round(usage.output));
  const reasoning = Math.max(0, Math.round(usage.reasoning));
  const cacheRead = Math.max(0, Math.round(usage.cacheRead));
  const cacheWrite = Math.max(0, Math.round(usage.cacheWrite));
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
