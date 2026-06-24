import {
  buildCausalTimeline,
  buildDeterministicSuggestions,
  compareToBaseline,
  computeEffectiveness,
  computeEfficiencyReport,
  evaluatePromiseChecks,
  evaluateRulePack,
  generateHandoffMarkdown,
  materializeWorkflowGraph,
  projectKey,
  roleFromPrompt,
  type BaselineComparison,
  type EffectivenessReport,
  type EfficiencyMetric,
  type EfficiencyReport,
  type PromiseCheck,
  type RuleFinding,
  type RulePack,
  type RunSummary,
  type Suggestion,
  type TraceEvent,
  type WorkflowGraph,
  type WorkflowNode
} from "@agent-blackbox/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  createAgentTreeLayout,
  createTimelineMarks,
  createWorkflowSteps,
  filterWorkflowStepsBySeq,
  hostDisplayName,
  summarizeAgentActivity,
  type AgentTreeConnection,
  type AgentTreeItem,
  type AgentTreeLayout,
  type TokenUsage,
  type WorkflowBranch,
  type WorkflowStep
} from "../graphLayout.js";
import { filterEventsForRun, latestRunId, listRuns } from "../runSelection.js";

declare global {
  interface Window {
    AGENT_BLACKBOX_DAEMON_URL?: string;
  }
}

// Runtime override (injected by `up` static server) wins, then build-time env,
// then the default port.
const daemonUrl =
  (typeof window !== "undefined" ? window.AGENT_BLACKBOX_DAEMON_URL : undefined) ??
  import.meta.env.VITE_AGENT_BLACKBOX_DAEMON_URL ??
  "http://127.0.0.1:47831";

const TREE_ROOT_COLUMN_WIDTH = 172;
const TREE_BRANCH_COLUMN_WIDTH = 104;
const TREE_COLUMN_GAP = 14;
const TREE_ROW_HEIGHT = 46;
const TREE_ROW_GAP = 26;
const TREE_MIN_SCALE = 0.12;
// The auto-fit never upscales past 1:1 — the tree transform multiplies font
// sizes, so magnifying small runs would render the same node title at different
// effective sizes per run. Manual zoom (below) is what lets a user push past it.
const TREE_MAX_SCALE = 1;
// Manual zoom is a multiplier layered on top of the auto-fit scale: 1 = fitted,
// >1 magnifies to read a dense run, <1 pulls back. Bounds keep it usable. The
// ceiling is high because on a big run the auto-fit scale is small, so even 4×
// left nodes tiny — 8× lets a dense tree reach roughly 1:1 and read clearly.
// Effective scale a run should open at (fit × initial zoom). ~0.5 keeps node titles
// legible on a dense tree; the user can still zoom out (or hit 100% to fit the whole).
const READABLE_TARGET_SCALE = 0.5;
const USER_ZOOM_MIN = 0.4;
const USER_ZOOM_MAX = 8;
const USER_ZOOM_STEP = 1.2;
// Apply at most one streamed snapshot per this interval (keep the latest). The daemon
// can broadcast every ~150ms; a big session is costly to re-lay-out, so coalescing
// here bounds main-thread work and keeps the live view smooth.
const SNAPSHOT_APPLY_INTERVAL_MS = 400;

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { message: string };
};

type TraceSnapshot = {
  events: TraceEvent[];
  graph: WorkflowGraph;
  checks: PromiseCheck[];
  baselines?: RunSummary[]; // optional — older daemons don't send it
  rulePacks?: Record<string, RulePack>; // optional — custom checks keyed by project (cwd basename)
  handoffMarkdown: string;
  replay: {
    mode: "live" | "seq" | "time";
    seq?: number;
    at?: string;
  };
};

type StreamMessage =
  | {
      type: "snapshot";
      data: TraceSnapshot;
    }
  | {
      type: "error";
      error: { message: string };
    };

export function DashboardApp() {
  const [snapshot, setSnapshot] = useState<TraceSnapshot | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showHandoff, setShowHandoff] = useState(false);
  const [handoffCopied, setHandoffCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("abb-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("abb-theme", theme);
    } catch {
      // Private-mode storage failures are non-fatal — the theme still applies.
    }
  }, [theme]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
    // Coalesce snapshot application — keep only the latest and apply at most once per
    // SNAPSHOT_APPLY_INTERVAL_MS, so a fast stream can't pin the main thread.
    let latest: TraceSnapshot | null = null;
    let lastAppliedAt = 0;
    let applyTimer: ReturnType<typeof setTimeout> | null = null;
    const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const applyNow = () => {
      applyTimer = null;
      if (!active || !latest) return;
      lastAppliedAt = nowMs();
      setSnapshot(latest);
      setError(null);
      latest = null;
    };
    const scheduleApply = (data: TraceSnapshot) => {
      latest = data;
      const since = nowMs() - lastAppliedAt;
      if (since >= SNAPSHOT_APPLY_INTERVAL_MS) applyNow();
      else if (applyTimer === null) applyTimer = setTimeout(applyNow, SNAPSHOT_APPLY_INTERVAL_MS - since);
    };
    async function loadSnapshot() {
      try {
        const query = selectedSeq === null ? "" : `?seq=${selectedSeq}`;
        const response = await fetch(`${daemonUrl}/snapshot${query}`);
        const payload = (await response.json()) as ApiResponse<TraceSnapshot>;
        if (!active) return;
        if (!payload.ok || !payload.data) {
          setError(payload.error?.message ?? "Daemon returned no snapshot");
          return;
        }
        scheduleApply(payload.data);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadSnapshot();
    if (selectedSeq === null && typeof WebSocket !== "undefined") {
      socket = new WebSocket(toStreamUrl(daemonUrl));
      socket.onmessage = (message) => {
        if (!active) return;
        try {
          const payload = JSON.parse(message.data as string) as StreamMessage;
          if (payload.type === "snapshot") {
            scheduleApply(payload.data);
          } else {
            setError(payload.error.message);
          }
        } catch (streamError) {
          setError(streamError instanceof Error ? streamError.message : String(streamError));
        }
      };
    }
    const interval = window.setInterval(() => {
      void loadSnapshot();
    }, selectedSeq === null ? 5000 : 1500);
    return () => {
      active = false;
      socket?.close();
      window.clearInterval(interval);
      if (applyTimer !== null) clearTimeout(applyTimer);
    };
  }, [selectedSeq]);

  const runs = useMemo(() => listRuns(snapshot?.events ?? []), [snapshot]);
  const latestRun = useMemo(() => latestRunId(snapshot?.events ?? []), [snapshot]);
  const activeRunId = useMemo(() => {
    if (selectedRunId && runs.some((run) => run.runId === selectedRunId)) return selectedRunId;
    return latestRun;
  }, [selectedRunId, runs, latestRun]);
  const visibleEvents = useMemo(
    () => filterEventsForRun(snapshot?.events ?? [], activeRunId),
    [snapshot, activeRunId]
  );
  const runOptions = useMemo(
    () =>
      runs.map((run) => ({
        runId: run.runId,
        eventCount: run.eventCount,
        host: run.host,
        label: sessionDisplayName(filterEventsForRun(snapshot?.events ?? [], run.runId), run.runId)
      })),
    [runs, snapshot]
  );
  const graph = useMemo(() => {
    // Reuse the daemon's already-built graph when the live view covers the whole log
    // (single run). Re-materializing on the client costs ~450ms at 50k events and runs
    // on every streamed snapshot — the dominant source of long-session stutter. Replay
    // or a per-run filter (visible slice ≠ whole log) still rebuilds from what's shown.
    if (
      selectedSeq === null &&
      snapshot?.graph &&
      snapshot.replay?.mode === "live" &&
      snapshot.graph.runId === activeRunId &&
      visibleEvents.length === (snapshot.events?.length ?? -1)
    ) {
      return snapshot.graph;
    }
    return visibleEvents.length > 0 ? materializeWorkflowGraph(visibleEvents) : snapshot?.graph ?? null;
  }, [snapshot, visibleEvents, activeRunId, selectedSeq]);
  const agentNodes = graph?.nodes.filter(isRuntimeAgentNode) ?? [];
  const selectedAgent = agentNodes.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentLabel = selectedAgent?.label ?? null;
  const workflowSteps = useMemo(() => createWorkflowSteps(visibleEvents), [visibleEvents]);
  const tokenTotals = useMemo(() => latestTokenUsage(visibleEvents), [visibleEvents]);
  const efficiency = useMemo(() => computeEfficiencyReport(visibleEvents), [visibleEvents]);
  // Promise-checks scan message text with regexes — compute once and share between
  // the effectiveness axis and the handoff markdown (was run twice per render).
  const promiseChecks = useMemo(() => evaluatePromiseChecks(visibleEvents), [visibleEvents]);
  const effectiveness = useMemo(() => computeEffectiveness(visibleEvents, promiseChecks), [visibleEvents, promiseChecks]);
  const suggestions = useMemo(() => buildDeterministicSuggestions(efficiency), [efficiency]);
  // Project's custom rule pack, evaluated against the viewed run (separate from the
  // efficiency score so house rules don't distort cross-project baselines).
  const ruleFindings = useMemo<RuleFinding[]>(() => {
    // Pick the pack for the project of the run we're VIEWING (not whichever project
    // dominates the daemon's whole window).
    const proj = projectKey(visibleEvents);
    const pack = proj ? snapshot?.rulePacks?.[proj] : undefined;
    return pack ? evaluateRulePack(visibleEvents, pack) : [];
  }, [snapshot, visibleEvents]);
  // Score the viewed run against your usual run of the same archetype (heavy history
  // lives daemon-side; the snapshot ships the compact summaries).
  const baselineComparison = useMemo<BaselineComparison | null>(() => {
    if (!snapshot?.baselines || !activeRunId) return null;
    const project = projectKey(visibleEvents);
    return compareToBaseline(
      {
        runId: activeRunId,
        ts: "",
        archetype: efficiency.archetype,
        score: efficiency.overallScore,
        inputTokens: efficiency.totalInputTokens,
        ...(project ? { project } : {})
      },
      snapshot.baselines
    );
  }, [snapshot, activeRunId, efficiency, visibleEvents]);
  const [metricHighlight, setMetricHighlight] = useState<{ ids: string[]; nonce: number }>({ ids: [], nonce: 0 });
  const [aiState, setAiState] = useState<{ suggestions: Suggestion[]; provider: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [showOptimize, setShowOptimize] = useState(false);
  // Advice is generated on request, not on sight — the panel stays an observation
  // (score + metrics) until you ask for fixes.
  const [adviceRequested, setAdviceRequested] = useState(false);

  // Stale advice shouldn't bleed across runs. Key this on the run actually being
  // VIEWED (activeRunId), not just the manual pick (selectedRunId): when the view
  // auto-follows "latest" and a new run appears, activeRunId changes while
  // selectedRunId stays null — so keying on selectedRunId let advice from the old run
  // linger against the new run's score (the "advice shown, score 100" desync).
  useEffect(() => {
    setAiState(null);
    setAdviceRequested(false);
  }, [activeRunId]);

  const requestAiSuggestions = async () => {
    setAiLoading(true);
    try {
      const response = await fetch(`${daemonUrl}/suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Attach a redacted causal timeline so the model respects compaction
        // boundaries (a re-read after a compact is expected, not waste).
        body: JSON.stringify({ report: efficiency, timeline: buildCausalTimeline(visibleEvents) })
      });
      const json = (await response.json()) as { ok: boolean; data?: { suggestions: Suggestion[]; provider: string } };
      if (json.ok && json.data) setAiState(json.data);
    } catch {
      // Daemon unreachable — keep the deterministic suggestions already shown.
    } finally {
      setAiLoading(false);
    }
  };
  // Reveal advice and kick off model-tailored suggestions, both only on request.
  // Pin the view to the run the advice is about (stop auto-following "latest") so a
  // run that becomes latest mid-request — e.g. the suggestion model's own
  // `opencode run` — can't yank the view, and its score, out from under the advice.
  // Pinning to the already-active run leaves activeRunId unchanged, so the reset
  // effect above doesn't fire and clear the advice we're requesting.
  const requestAdvice = () => {
    if (activeRunId) setSelectedRunId(activeRunId);
    setAdviceRequested(true);
    void requestAiSuggestions();
  };
  const sessionName = useMemo(() => sessionDisplayName(visibleEvents, graph?.runId), [visibleEvents, graph]);
  const runHost = visibleEvents[0]?.host ?? null;
  // The memory file the actuator will target for this run's host (Claude Code reads
  // CLAUDE.md, everyone else AGENTS.md) — keeps the side-panel hint honest.
  const memoryFile = runHost === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
  // The model this run is on (latest message carrying one) — surfaced as a chip so
  // it's visible at a glance, like the host.
  const runModel = useMemo(() => {
    for (let i = visibleEvents.length - 1; i >= 0; i -= 1) {
      const model = visibleEvents[i]?.payload?.model;
      if (typeof model === "string" && model.length > 0 && model !== "<synthetic>") return model;
    }
    return null;
  }, [visibleEvents]);
  const runStatus = useMemo(() => deriveRunStatus(visibleEvents), [visibleEvents]);
  const riskMomentCount = useMemo(() => workflowSteps.filter((step) => step.tone === "risk").length, [workflowSteps]);
  const handoffMarkdown = useMemo(
    () => (graph ? generateHandoffMarkdown(graph, promiseChecks) : ""),
    [graph, promiseChecks]
  );
  const orderedEvents = useMemo(() => [...visibleEvents].sort((a, b) => a.seq - b.seq), [visibleEvents]);
  const marks = useMemo(() => createTimelineMarks(orderedEvents), [orderedEvents]);
  const maxSeq = orderedEvents.at(-1)?.seq ?? 0;
  const replaySeq = selectedSeq ?? maxSeq;
  const replaySteps = useMemo(() => filterWorkflowStepsBySeq(workflowSteps, replaySeq), [workflowSteps, replaySeq]);
  const replayEvents = useMemo(() => visibleEvents.filter((event) => event.seq <= replaySeq), [visibleEvents, replaySeq]);
  const selectedStep = selectedEventId
    ? replaySteps.find(
        (step) => step.eventId === selectedEventId || step.branches.some((branch) => branch.eventId === selectedEventId)
      ) ?? null
    : null;
  const selectedBranch =
    selectedStep && selectedEventId && selectedEventId !== selectedStep.eventId
      ? selectedStep.branches.find((branch) => branch.eventId === selectedEventId) ?? null
      : null;
  const inspectedEventId = selectedBranch?.eventId ?? selectedStep?.eventId ?? null;
  const selectedEvent = inspectedEventId ? visibleEvents.find((event) => event.id === inspectedEventId) ?? null : null;
  const selectWorkflowEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    setSelectedFilePath(null);
    setSelectedAgentId(null);
  };
  const selectFile = (path: string) => {
    setSelectedFilePath(path);
    setSelectedEventId(null);
    setSelectedAgentId(null);
  };
  const clearFocus = () => {
    setSelectedAgentId(null);
    setSelectedEventId(null);
    setSelectedFilePath(null);
  };
  // File data for the FILES panel (now docked in the right co-pilot column).
  const fileConnections = useMemo(() => createFileConnections(replaySteps), [replaySteps]);
  const fileRows = useMemo(() => createFileRows(fileConnections), [fileConnections]);
  const subagentLabels = useMemo(
    () => new Set(replaySteps.map((step) => step.agentLabel).filter((label): label is string => Boolean(label))),
    [replaySteps]
  );
  const filesSelectedAgentIsRoot = selectedAgentLabel !== null && !subagentLabels.has(selectedAgentLabel);
  const filesFocusedStepId = selectedFilePath ? null : selectedStep?.id ?? null;
  const filesHasFocus = Boolean(selectedEventId || selectedFilePath || selectedAgentLabel);

  // Connection lines from a moment node (in the map) to the file it touched (in
  // the co-pilot). Measured at the workspace level so they span both columns
  // instead of being clipped to the map canvas.
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [fileEdges, setFileEdges] = useState<{ id: string; path: string; stepId: string; pathD: string }[]>([]);
  // The map viewport band (workspace-relative) the file lines are clipped to, so
  // zooming/panning never bleeds a line over the header, topbar, or timeline.
  const [edgeClip, setEdgeClip] = useState<{ left: number; top: number; width: number; height: number }>({
    left: 0,
    top: 0,
    width: 0,
    height: 0
  });

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return undefined;
    const measure = () => {
      const wsRect = workspace.getBoundingClientRect();
      // The map scrolls/zooms inside its own clipped viewport; clamp the lines to
      // that band so a zoomed-out-of-view node never trails a line across the rest
      // of the console.
      const mapEl = workspace.querySelector<HTMLElement>(".mapCanvas");
      const mapRect = mapEl ? mapEl.getBoundingClientRect() : wsRect;
      // Clip lines to the map viewport (left + top/bottom band, extending right to
      // the files). A line whose origin scrolls out of view is partially clipped at
      // the boundary — like a node — rather than vanishing whole.
      const clipLeft = Math.max(0, mapRect.left - wsRect.left);
      const clipTop = Math.max(0, mapRect.top - wsRect.top);
      const clipBottom = Math.min(wsRect.height, mapRect.bottom - wsRect.top);
      setEdgeClip({
        left: clipLeft,
        top: clipTop,
        width: Math.max(0, wsRect.width - clipLeft),
        height: Math.max(0, clipBottom - clipTop)
      });
      const stepEls = new Map<string, HTMLElement>();
      const fileEls = new Map<string, HTMLElement>();
      workspace.querySelectorAll<HTMLElement>("[data-step-id]").forEach((el) => {
        if (el.dataset.stepId) stepEls.set(el.dataset.stepId, el);
      });
      workspace.querySelectorAll<HTMLElement>("[data-file-anchor-path]").forEach((el) => {
        if (el.dataset.fileAnchorPath) fileEls.set(el.dataset.fileAnchorPath, el);
      });
      const edges = fileConnections.flatMap((connection) => {
        const stepEl = stepEls.get(connection.stepId);
        const fileEl = fileEls.get(connection.path);
        if (!stepEl || !fileEl) return [];
        // Originate the file line from the node's ring (now on its right edge).
        const ringEl = stepEl.querySelector<HTMLElement>(".stepMarker, .agentStemDot") ?? stepEl;
        const s = ringEl.getBoundingClientRect();
        const ringCx = s.left + s.width / 2;
        const ringCy = s.top + s.height / 2;
        const f = fileEl.getBoundingClientRect();
        const startX = ringCx - wsRect.left;
        const startY = ringCy - wsRect.top;
        const endX = f.left - wsRect.left;
        const endY = f.top + f.height / 2 - wsRect.top;
        const bend = Math.max(40, Math.min(180, (endX - startX) / 2));
        return [
          {
            id: `${connection.stepId}__${connection.path}`,
            path: connection.path,
            stepId: connection.stepId,
            pathD: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`
          }
        ];
      });
      setFileEdges(edges);
    };
    let frame = 0;
    let burstUntil = 0;
    const run = () => {
      frame = 0;
      measure();
      if (Date.now() < burstUntil) frame = window.requestAnimationFrame(run);
    };
    const schedule = () => {
      burstUntil = Math.max(burstUntil, Date.now() + 420);
      if (!frame) frame = window.requestAnimationFrame(run);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(workspace);
    window.addEventListener("agent-blackbox:layout", schedule);
    window.addEventListener("resize", schedule);
    workspace.addEventListener("scroll", schedule, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("agent-blackbox:layout", schedule);
      window.removeEventListener("resize", schedule);
      workspace.removeEventListener("scroll", schedule, true);
    };
  }, [fileConnections]);
  const chooseRun = (runId: string | null) => {
    setSelectedRunId(runId);
    // A selection or replay position from the previous run is meaningless in the
    // next one, so reset focus and return to live.
    setSelectedAgentId(null);
    setSelectedEventId(null);
    setSelectedFilePath(null);
    setSelectedSeq(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showOptimize) {
        setShowOptimize(false);
      } else if (showHandoff) {
        setShowHandoff(false);
      } else {
        clearFocus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showHandoff, showOptimize]);

  return (
    <main className="shell">
      <header className="topbar">
        <strong>{sessionName}</strong>
        <div className="topbarStatus">
          {runOptions.length > 1 ? (
            <select
              aria-label="Select run"
              className="runPicker"
              onChange={(event) => chooseRun(event.target.value || null)}
              value={selectedRunId && runOptions.some((run) => run.runId === selectedRunId) ? selectedRunId : ""}
            >
              <option value="">Latest run (auto)</option>
              {runOptions.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.label} · {hostDisplayName(run.host)} · {run.eventCount} ev
                </option>
              ))}
            </select>
          ) : null}
          {runHost ? <span className="statusChip host">{hostDisplayName(runHost)}</span> : null}
          {runModel ? <span className="statusChip model" title="Model">{runModel}</span> : null}
          <span className={`statusChip state state-${runStatus}`}>
            <span className="statusDot" aria-hidden="true" />
            {runStatus}
          </span>
          <span className="statusChip">{visibleEvents.length} events</span>
          {riskMomentCount > 0 ? (
            <button
              className="statusChip risk"
              onClick={() => {
                const firstRisk = workflowSteps.find((step) => step.tone === "risk");
                if (firstRisk) selectWorkflowEvent(firstRisk.eventId);
              }}
              title="Jump to the first risk moment"
              type="button"
            >
              {riskMomentCount} risk {riskMomentCount === 1 ? "moment" : "moments"}
            </button>
          ) : null}
          <button
            className="themeToggle"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            type="button"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            className="topbarAction"
            disabled={visibleEvents.length === 0}
            onClick={() => {
              setHandoffCopied(false);
              setShowHandoff(true);
            }}
            type="button"
          >
            Handoff
          </button>
        </div>
      </header>

      {showHandoff ? (
        <div
          className="handoffOverlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setShowHandoff(false);
          }}
          role="presentation"
        >
          <aside className="handoffPanel" aria-label="Handoff summary">
            <div className="handoffHeader">
              <h2>Handoff summary</h2>
              <div className="handoffActions">
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(handoffMarkdown).then(
                      () => setHandoffCopied(true),
                      () => setHandoffCopied(false)
                    );
                  }}
                  type="button"
                >
                  {handoffCopied ? "Copied" : "Copy markdown"}
                </button>
                <button onClick={() => setShowHandoff(false)} type="button">
                  Close
                </button>
              </div>
            </div>
            <pre className="handoffBody">{handoffMarkdown}</pre>
          </aside>
        </div>
      ) : null}

      {showOptimize ? <OptimizeModal onClose={() => setShowOptimize(false)} runId={activeRunId} /> : null}

      {error ? (
        <div className="banner">
          Can’t reach the trace daemon at {daemonUrl} ({error}). Start it with <code>npm run up</code> (or{" "}
          <code>agent-blackbox daemon --project &lt;dir&gt;</code>), then this view reconnects automatically.
        </div>
      ) : null}

      <section className="workspace" ref={workspaceRef}>
        <svg className={`fileEdgeLayer ${filesHasFocus ? "hasFocus" : ""}`} aria-hidden="true">
          <defs>
            <clipPath id="fileEdgeClip">
              <rect x={edgeClip.left} y={edgeClip.top} width={edgeClip.width} height={edgeClip.height} />
            </clipPath>
          </defs>
          <g clipPath={edgeClip.height > 0 ? "url(#fileEdgeClip)" : undefined}>
            {fileEdges.map((edge) => {
              const focused =
                edge.path === selectedFilePath || (filesFocusedStepId !== null && edge.stepId === filesFocusedStepId);
              return <path className={focused ? "fileEdge focused" : "fileEdge"} d={edge.pathD} key={edge.id} />;
            })}
          </g>
        </svg>
        <aside className="lanes" aria-label="Agent lanes">
          <h2>Agents</h2>
          {agentNodes.length === 0 ? <p className="muted">No agent lanes yet.</p> : null}
          {agentNodes.map((agent) => (
            <button
              className={agent.id === selectedAgentId ? "lane active" : "lane"}
              key={agent.id}
              onClick={() => {
                setSelectedAgentId((current) => (current === agent.id ? null : agent.id));
                setSelectedEventId(null);
                setSelectedFilePath(null);
              }}
              type="button"
            >
              <span className="laneMarker" />
              <span className="laneMain">
                <strong>{agentDisplayName(agent)}</strong>
                <span>{agent.type.toLowerCase()}</span>
              </span>
              <span className="laneBadges">
                {/* A finished run shouldn't show every lane as ACTIVE — a subagent
                    transcript rarely emits a clean end, so the node status sticks at
                    ACTIVE. When the run isn't live, render those as DONE. */}
                <StatusBadge status={runStatus !== "active" && agent.status === "ACTIVE" ? "DONE" : agent.status} />
              </span>
            </button>
          ))}
        </aside>

        <SessionMap
          agentNodes={agentNodes}
          events={replayEvents}
          metricHighlight={metricHighlight}
          onClearFocus={clearFocus}
          onSelectEvent={selectWorkflowEvent}
          onSelectSeq={setSelectedSeq}
          replaySeq={replaySeq}
          selectedAgentLabel={selectedAgentLabel}
          selectedBranch={selectedBranch}
          selectedEvent={selectedEvent}
          selectedEventId={selectedEventId}
          selectedFilePath={selectedFilePath}
          selectedStep={selectedStep}
          steps={replaySteps}
        />

        <aside className="copilot" aria-label="Context efficiency and files">
          <ContextPanel
            report={efficiency}
            effectiveness={effectiveness}
            baseline={baselineComparison}
            ruleFindings={ruleFindings}
            suggestions={aiState?.suggestions ?? suggestions}
            usage={tokenTotals}
            aiProvider={aiState?.provider ?? null}
            aiLoading={aiLoading}
            adviceRequested={adviceRequested}
            onRequestAdvice={requestAdvice}
            onRequestAi={requestAiSuggestions}
            onOptimize={() => setShowOptimize(true)}
            onSelectMetric={(metric) =>
              setMetricHighlight((current) => ({ ids: metric.evidenceEventIds, nonce: current.nonce + 1 }))
            }
            memoryFile={memoryFile}
          />
          <FileStructure
            hasFocus={filesHasFocus}
            onSelectFile={selectFile}
            rows={fileRows}
            selectedAgentIsRoot={filesSelectedAgentIsRoot}
            selectedAgentLabel={selectedAgentLabel}
            selectedEventId={selectedEventId}
            selectedFilePath={selectedFilePath}
            selectedStepId={filesFocusedStepId}
          />
        </aside>
      </section>

      <footer className="timelineBar" aria-label="Replay timeline">
        <div className="ticks">
          {marks.slice(-160).map((mark) => (
            <button
              className={`tick tick-${mark.tone} ${mark.seq <= replaySeq ? "seen" : ""}`}
              key={mark.id}
              onClick={() => setSelectedSeq(mark.seq)}
              title={`${mark.seq}. ${mark.label}`}
              type="button"
            />
          ))}
        </div>
        <div className="timelineControls">
          <button
            className="timelineLive"
            disabled={selectedSeq === null}
            onClick={() => setSelectedSeq(null)}
            type="button"
          >
            {selectedSeq === null ? "● Live" : "Go live"}
          </button>
          <input
            aria-label="Replay sequence"
            className="timelineRange"
            max={maxSeq}
            min={0}
            onChange={(event) => setSelectedSeq(Number(event.currentTarget.value))}
            type="range"
            value={replaySeq}
          />
          <span className="timelineLabel">
            {selectedSeq === null ? "live" : `seq ${replaySeq}`} / {maxSeq}
          </span>
        </div>
      </footer>
    </main>
  );
}

function SessionMap({
  agentNodes,
  events,
  metricHighlight,
  onClearFocus,
  onSelectEvent,
  onSelectSeq,
  replaySeq,
  selectedAgentLabel,
  selectedBranch,
  selectedEvent,
  selectedEventId,
  selectedFilePath,
  selectedStep,
  steps
}: {
  agentNodes: WorkflowNode[];
  events: TraceEvent[];
  metricHighlight: { ids: string[]; nonce: number };
  onClearFocus: () => void;
  onSelectEvent: (eventId: string) => void;
  onSelectSeq: (seq: number) => void;
  replaySeq: number;
  selectedAgentLabel: string | null;
  selectedBranch: WorkflowBranch | null;
  selectedEvent: TraceEvent | null;
  selectedEventId: string | null;
  selectedFilePath: string | null;
  selectedStep: WorkflowStep | null;
  steps: WorkflowStep[];
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);
  const [momentAnchor, setMomentAnchor] = useState<{ left: number; top: number } | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<NodeOffsetMap>({});
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  const [selectionDrag, setSelectionDrag] = useState<SelectionDrag | null>(null);
  const [autoLayouting, setAutoLayouting] = useState(false);
  const treeLayout = useMemo(() => createAgentTreeLayout(steps), [steps]);
  const treeMetrics = useMemo(() => createTreeLayoutMetrics(treeLayout), [treeLayout]);
  const [treeFitScale, setTreeFitScale] = useState(1);
  const [userZoom, setUserZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // Open a dense run at a READABLE zoom, not fit-to-tiny. The fit scale (≤1) shrinks
  // a big tree until everything fits — illegible at 60 lanes. On a run change we
  // reset to fit, then once the fit is measured we bump the manual zoom so the
  // effective scale clears a readable floor. The user's own zoom afterward sticks;
  // the % button still resets to 100% = fit the whole tree.
  const zoomInitForRun = useRef<string>("");
  const runSignature = events[0]?.runId ?? "";
  useEffect(() => {
    setUserZoom(1);
    zoomInitForRun.current = "";
  }, [runSignature]);
  useEffect(() => {
    if (runSignature && zoomInitForRun.current !== runSignature && treeFitScale > 0 && treeFitScale < 1) {
      zoomInitForRun.current = runSignature;
      setUserZoom(clamp(READABLE_TARGET_SCALE / treeFitScale, 1, USER_ZOOM_MAX));
    }
  }, [runSignature, treeFitScale]);
  // Live "tracing": keep the newest node in view as events stream in. On by default
  // so a running session auto-follows; any direct map gesture (click/drag/wheel-pan)
  // pins the view, and the Tracing button re-engages it.
  const [follow, setFollow] = useState(true);
  // The scale actually applied to the tree: auto-fit × the user's manual zoom.
  const appliedScale = clamp(treeFitScale * userZoom, TREE_MIN_SCALE * 0.5, USER_ZOOM_MAX);
  // The newest node (highest row) — the camera target while tracing live.
  const latestItem = useMemo(() => {
    let best: AgentTreeItem | null = null;
    for (const item of treeLayout.items) if (!best || item.row > best.row) best = item;
    return best;
  }, [treeLayout.items]);
  const selectedAgentIsRoot =
    selectedAgentLabel !== null && !treeLayout.lanes.some((lane) => lane.id !== "root" && lane.label === selectedAgentLabel);
  const fileConnections = useMemo(() => createFileConnections(steps), [steps]);
  const agentDetail = useMemo<AgentDetail | null>(() => {
    if (!selectedBranch || selectedBranch.kind !== "agent") return null;
    const label = selectedBranch.label;
    const node = agentNodes.find((agent) => agent.label === label);
    const activity = summarizeAgentActivity(events, label);
    return {
      commands: activity.commands,
      files: activity.files,
      label,
      moments: activity.moments,
      role: selectedBranch.detail ?? "agent",
      status: node?.status ?? null
    };
  }, [selectedBranch, agentNodes, events]);
  const [measuredEdges, setMeasuredEdges] = useState<MeasuredEdge[]>([]);
  const [measuredTreeEdges, setMeasuredTreeEdges] = useState<MeasuredTreeEdge[]>([]);
  const treeItemIds = useMemo(() => new Set(treeLayout.items.map((item) => item.id)), [treeLayout.items]);
  const selectionBox = selectionDrag ? rectFromPoints(selectionDrag.start, selectionDrag.current) : null;
  const selectedFileStepIds = useMemo(() => {
    if (!selectedFilePath) return new Set<string>();
    return new Set(fileConnections.filter((connection) => connection.path === selectedFilePath).map((connection) => connection.stepId));
  }, [fileConnections, selectedFilePath]);
  const selectedTreeFocus = useMemo(
    () => createSelectedTreeFocus(treeLayout.items, selectedNodeIds),
    [selectedNodeIds, treeLayout.items]
  );
  const hasFocus = Boolean(selectedEventId || selectedFilePath || selectedAgentLabel || selectedNodeIds.size > 0);
  const showInspector = Boolean(selectedEventId || selectedFilePath);


  useEffect(() => {
    if (!nodeDrag) return undefined;

    const move = (event: PointerEvent) => {
      const dx = event.clientX - nodeDrag.startX;
      const dy = event.clientY - nodeDrag.startY;
      movedRef.current = movedRef.current || Math.abs(dx) > 2 || Math.abs(dy) > 2;
      if (!movedRef.current) return;
      const scaledDx = dx / appliedScale;
      const scaledDy = dy / appliedScale;
      setNodeOffsets((current) => {
        const next = { ...current };
        for (const id of nodeDrag.nodeIds) {
          const startOffset = nodeDrag.startOffsets[id] ?? { x: 0, y: 0 };
          next[id] = {
            x: Math.round(startOffset.x + scaledDx),
            y: Math.round(startOffset.y + scaledDy)
          };
        }
        return next;
      });
      requestLayoutMeasure();
    };
    const stop = () => {
      // A plain click (no drag, no modifier) focuses the node and opens the
      // inspector. A modifier-click only toggles multi-selection, and any drag
      // suppresses the popup entirely.
      if (!movedRef.current && !nodeDrag.additive) {
        onSelectEvent(nodeDrag.eventId);
      }
      setNodeDrag(null);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "grabbing";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [nodeDrag, onSelectEvent, appliedScale]);

  useEffect(() => {
    if (!selectionDrag) return undefined;

    const move = (event: PointerEvent) => {
      const container = mapRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      setSelectionDrag((current) =>
        current
          ? {
              ...current,
              current: {
                x: event.clientX - containerRect.left,
                y: event.clientY - containerRect.top
              }
            }
          : current
      );
    };
    const stop = () => {
      const container = mapRef.current;
      if (!container) {
        setSelectionDrag(null);
        return;
      }
      const rect = selectionDrag ? rectFromPoints(selectionDrag.start, selectionDrag.current) : null;
      if (!rect || rect.width < 6 || rect.height < 6) {
        if (!selectionDrag.additive) {
          setSelectedNodeIds(new Set());
          onClearFocus();
        }
        setSelectionDrag(null);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const selected = new Set(selectionDrag.additive ? selectedNodeIds : []);
      container.querySelectorAll<HTMLElement>("[data-tree-node-id]").forEach((element) => {
        const id = element.dataset.treeNodeId;
        if (!id) return;
        const elementRect = element.getBoundingClientRect();
        const localRect = {
          height: elementRect.height,
          left: elementRect.left - containerRect.left,
          top: elementRect.top - containerRect.top,
          width: elementRect.width
        };
        if (rectsIntersect(rect, localRect)) {
          selected.add(id);
        }
      });
      setSelectedNodeIds(selected);
      if (!selectionDrag.additive) {
        onClearFocus();
      }
      setSelectionDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [onClearFocus, selectionDrag, selectedNodeIds]);

  useEffect(() => {
    setSelectedNodeIds((current) => {
      const next = new Set([...current].filter((id) => treeItemIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [treeItemIds]);

  // Clicking an efficiency metric in the rail highlights the tree nodes whose
  // events the metric flagged (re-reads, big injections, failed retries, …).
  useEffect(() => {
    if (metricHighlight.ids.length === 0) return;
    const want = new Set(metricHighlight.ids);
    const ids = new Set<string>();
    for (const item of treeLayout.items) {
      if (item.type === "step") {
        if (want.has(item.step.eventId) || item.step.branches.some((branch) => want.has(branch.eventId))) {
          ids.add(item.id);
        }
      } else if (want.has(item.branch.eventId)) {
        ids.add(item.id);
      }
    }
    if (ids.size > 0) setSelectedNodeIds(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricHighlight.nonce, treeLayout]);

  // Wheel over the map: pinch / ctrl+wheel zooms, a plain wheel pans. Attached
  // natively (not via React's passive onWheel) so we can preventDefault and stop
  // the page from scrolling underneath the canvas.
  useEffect(() => {
    const container = mapRef.current;
    if (!container) return undefined;
    const onWheel = (event: WheelEvent) => {
      // Don't hijack scrolling inside the docked file panel or the inspector.
      const target = event.target as HTMLElement | null;
      if (target?.closest(".fileStructure, .glassInspector")) return;
      event.preventDefault();
      // Any wheel gesture (pinch-zoom or pan) is the user taking manual control, so
      // pin the view — this also drops the .following transition so the gesture
      // tracks the pointer instead of easing behind it.
      setFollow(false);
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0015);
        setUserZoom((zoom) => clamp(zoom * factor, USER_ZOOM_MIN, USER_ZOOM_MAX));
      } else {
        setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
      }
      requestLayoutMeasure();
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // Live tracing: pan the camera to keep the newest node in view. Re-runs when a new
  // node arrives, the zoom changes, or tracing is re-engaged. Measured from the
  // rendered rects (robust to the tree's flex-centering/padding): center the latest
  // node, but if the whole tree fits a dimension, center the tree there instead (so
  // 100%/fit shows everything, not a clipped tail), and never scroll past its edges.
  useEffect(() => {
    if (!follow || !latestItem) return undefined;
    const container = mapRef.current;
    if (!container) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const grid = container.querySelector<HTMLElement>(".treeGrid");
      const node = container.querySelector<HTMLElement>(`[data-tree-node-id="${CSS.escape(latestItem.id)}"]`);
      if (!grid || !node) return;
      const map = container.getBoundingClientRect();
      const tree = grid.getBoundingClientRect();
      const target = node.getBoundingClientRect();
      const mapCx = map.left + map.width / 2;
      const mapCy = map.top + map.height / 2;
      let dx = tree.width <= map.width ? mapCx - (tree.left + tree.width / 2) : mapCx - (target.left + target.width / 2);
      let dy = tree.height <= map.height ? mapCy - (tree.top + tree.height / 2) : mapCy - (target.top + target.height / 2);
      if (tree.width > map.width) dx = clamp(dx, map.right - tree.right, map.left - tree.left);
      if (tree.height > map.height) dy = clamp(dy, map.bottom - tree.bottom, map.top - tree.top);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return; // already centered → don't churn
      setPan((current) => ({ x: Math.round(current.x + dx), y: Math.round(current.y + dy) }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [follow, latestItem, appliedScale]);

  useLayoutEffect(() => {
    const container = mapRef.current;
    if (!container) return undefined;
    const treeElement = container.querySelector<HTMLElement>(".workflowTree");
    if (!treeElement) return undefined;

    const fitTree = () => {
      // Measure the canvas itself, not the tree column: the column is now sized to
      // the rendered tree, so reading its width here would feed the scale back into
      // itself. Reserve room for the docked file panel and the column gap.
      const canvasRect = container.getBoundingClientRect();
      // Mirror the .mapCanvas padding (26px inset, plus the file column + 52px
      // reserve on the right) so the tree fits inside the breathing room. The
      // moment popover floats over the node, so no bottom space is reserved.
      const availableWidth = Math.max(120, canvasRect.width - 52);
      const availableHeight = Math.max(120, canvasRect.height - 52);
      const nextScale = clamp(
        Math.min(TREE_MAX_SCALE, availableWidth / treeMetrics.width, availableHeight / treeMetrics.height),
        TREE_MIN_SCALE,
        TREE_MAX_SCALE
      );
      setTreeFitScale((current) => (Math.abs(current - nextScale) < 0.01 ? current : Number(nextScale.toFixed(3))));
      requestLayoutMeasure();
    };

    const frame = window.requestAnimationFrame(fitTree);
    const observer = new ResizeObserver(fitTree);
    observer.observe(treeElement);
    window.addEventListener("resize", fitTree);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", fitTree);
    };
  }, [showInspector, treeMetrics.height, treeMetrics.width]);

  useLayoutEffect(() => {
    const container = mapRef.current;
    if (!container) return undefined;

    const measure = () => {
      const containerRect = container.getBoundingClientRect();
      const stepElements = new Map<string, HTMLElement>();
      const fileElements = new Map<string, HTMLElement>();
      const treeElements = new Map<string, HTMLElement>();
      container.querySelectorAll<HTMLElement>("[data-step-id]").forEach((element) => {
        const stepId = element.dataset.stepId;
        if (stepId) stepElements.set(stepId, element);
      });
      container.querySelectorAll<HTMLElement>("[data-file-anchor-path]").forEach((element) => {
        const path = element.dataset.fileAnchorPath;
        if (path) fileElements.set(path, element);
      });
      container.querySelectorAll<HTMLElement>("[data-tree-node-id]").forEach((element) => {
        const nodeId = element.dataset.treeNodeId;
        if (nodeId) treeElements.set(nodeId, element);
      });

      const nextEdges = fileConnections.flatMap((connection) => {
        const stepElement = stepElements.get(connection.stepId);
        const fileElement = fileElements.get(connection.path);
        if (!stepElement || !fileElement) return [];
        const stepRect = stepElement.getBoundingClientRect();
        const fileRect = fileElement.getBoundingClientRect();
        const startX = stepRect.right - containerRect.left;
        const startY = stepRect.top + stepRect.height / 2 - containerRect.top;
        const endX = fileRect.left + fileRect.width / 2 - containerRect.left;
        const endY = fileRect.top + fileRect.height / 2 - containerRect.top;
        const bend = Math.max(42, Math.min(120, (endX - startX) / 2));
        return [
          {
            ...connection,
            pathD: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`
          }
        ];
      });
      setMeasuredEdges(nextEdges);

      const nextTreeEdges = treeLayout.connections.flatMap((connection) => {
        const fromElement = treeElements.get(connection.fromNodeId);
        const toElement = treeElements.get(connection.toNodeId);
        if (!fromElement || !toElement) return [];
        // Connect ring-to-ring: each node's ring now sits on its right edge.
        const fromRing = fromElement.querySelector<HTMLElement>(".stepMarker, .agentStemDot") ?? fromElement;
        const toRing = toElement.querySelector<HTMLElement>(".stepMarker, .agentStemDot") ?? toElement;
        return [
          {
            ...connection,
            pathD: treeConnectionPath(
              fromRing.getBoundingClientRect(),
              toRing.getBoundingClientRect(),
              containerRect,
              connection.kind
            )
          }
        ];
      });
      setMeasuredTreeEdges(nextTreeEdges);

      // Anchor the moment popover beside the focused node (or file row). A
      // selected subagent branch also marks the trunk step that holds it, so
      // prefer the agent-start card to anchor next to the subagent box itself.
      const anchorEl = selectedFilePath
        ? container.closest(".workspace")?.querySelector<HTMLElement>(".fileRows .finderRow.selected") ?? null
        : container.querySelector<HTMLElement>(".treeNode.agentStartCard.selected") ??
          container.querySelector<HTMLElement>(".treeNode.selected");
      if (!anchorEl) {
        setMomentAnchor(null);
      } else {
        const rect = anchorEl.getBoundingClientRect();
        const popWidth = 296;
        const gap = 12;
        const nodeLeft = rect.left - containerRect.left;
        const nodeRight = rect.right - containerRect.left;
        const nodeTop = rect.top - containerRect.top;
        const nodeBottom = rect.bottom - containerRect.top;
        let left: number;
        let top: number;
        if (selectedFilePath) {
          // File rows live in the top-right panel: open the popover to their left.
          left = nodeLeft - gap - popWidth;
          top = nodeTop;
          if (left < 8) {
            left = nodeLeft;
            top = nodeBottom + gap;
          }
        } else {
          // Node moments: open BELOW the node, extending left — so the popover
          // clears the file-connection arcs that sweep right from the node's ring.
          top = nodeBottom + gap;
          left = nodeRight - popWidth;
        }
        left = Math.min(Math.max(8, left), Math.max(8, containerRect.width - popWidth - 8));
        top = Math.max(8, Math.min(top, Math.max(8, containerRect.height - 132)));
        setMomentAnchor({ left, top });
      }
    };

    let measureFrame: number | null = null;
    let burstUntil = 0;
    const runMeasure = () => {
      measureFrame = null;
      measure();
      if (Date.now() < burstUntil) {
        measureFrame = window.requestAnimationFrame(runMeasure);
      }
    };
    const scheduleMeasure = (duration = 520) => {
      burstUntil = Math.max(burstUntil, Date.now() + duration);
      if (measureFrame === null) {
        measureFrame = window.requestAnimationFrame(runMeasure);
      }
    };
    const observer = new ResizeObserver(() => scheduleMeasure());
    container.querySelectorAll<HTMLElement>(".treeGrid, .fileStructure, .workflowTree").forEach((element) => {
      observer.observe(element);
    });
    const scheduleMeasureEvent = () => scheduleMeasure();

    scheduleMeasure(620);
    window.addEventListener("resize", scheduleMeasureEvent);
    window.addEventListener("agent-blackbox:layout", scheduleMeasureEvent);
    container.addEventListener("scroll", scheduleMeasureEvent, true);
    return () => {
      if (measureFrame !== null) {
        window.cancelAnimationFrame(measureFrame);
      }
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasureEvent);
      window.removeEventListener("agent-blackbox:layout", scheduleMeasureEvent);
      container.removeEventListener("scroll", scheduleMeasureEvent, true);
    };
  }, [
    fileConnections,
    nodeOffsets,
    selectedEventId,
    selectedFilePath,
    steps,
    treeFitScale,
    treeLayout
  ]);

  const focusedStepId = selectedFilePath ? null : selectedStep?.id ?? null;
  const beginNodeDrag = (event: ReactPointerEvent<HTMLElement>, item: AgentTreeItem) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setFollow(false); // grabbing a node pins the view

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const isSelected = selectedNodeIds.has(item.id);
    const nextSelection = new Set(additive || isSelected ? selectedNodeIds : []);
    if (additive && isSelected && nextSelection.size > 1) {
      nextSelection.delete(item.id);
    } else {
      nextSelection.add(item.id);
    }
    const nodeIds = [...nextSelection];
    movedRef.current = false;
    setSelectedNodeIds(nextSelection);
    setNodeDrag({
      additive,
      eventId: item.type === "step" ? item.step.eventId : item.branch.eventId,
      moved: false,
      nodeIds,
      startOffsets: nodeIds.reduce<NodeOffsetMap>((accumulator, id) => {
        accumulator[id] = nodeOffsets[id] ?? { x: 0, y: 0 };
        return accumulator;
      }, {}),
      startX: event.clientX,
      startY: event.clientY
    });
  };
  const beginSelectionDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-tree-node-id], .fileStructure, .glassInspector, .workflowTools")) return;
    setFollow(false); // clicking/dragging the map pins the view here
    const container = mapRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const point = {
      x: event.clientX - containerRect.left,
      y: event.clientY - containerRect.top
    };
    setSelectionDrag({
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      current: point,
      start: point
    });
  };
  const zoomBy = (factor: number) => {
    setUserZoom((zoom) => clamp(zoom * factor, USER_ZOOM_MIN, USER_ZOOM_MAX));
    requestLayoutMeasure();
  };
  const resetView = () => {
    setUserZoom(1);
    setPan({ x: 0, y: 0 });
    requestLayoutMeasure();
  };
  const resetLayout = () => {
    setAutoLayouting(true);
    setSelectedNodeIds(new Set());
    onClearFocus();
    setUserZoom(1);
    setPan({ x: 0, y: 0 });
    window.requestAnimationFrame(() => {
      setNodeOffsets({});
      requestLayoutMeasure();
    });
    window.setTimeout(() => setAutoLayouting(false), 520);
  };

  return (
    <section className="sessionMap" aria-label="Session workflow map">
      <div className="workflowHeader">
        <div>
          <h2>Session Map</h2>
          <p>Main actions form the trunk. Agents fork into branches, then reconnect through files and decisions.</p>
        </div>
        <div className="workflowTools">
          <span>{steps.length} moments · {Math.max(0, treeLayout.lanes.length - 1)} branches</span>
          <div className="zoomControls" role="group" aria-label="Zoom the session map">
            <button
              onClick={() => zoomBy(1 / USER_ZOOM_STEP)}
              type="button"
              aria-label="Zoom out"
              disabled={userZoom <= USER_ZOOM_MIN + 0.001}
            >
              −
            </button>
            <button onClick={resetView} type="button" aria-label="Reset zoom" title="Reset zoom (100% = fit)">
              {Math.round(userZoom * 100)}%
            </button>
            <button
              onClick={() => zoomBy(USER_ZOOM_STEP)}
              type="button"
              aria-label="Zoom in"
              disabled={userZoom >= USER_ZOOM_MAX - 0.001}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className={`traceToggle ${follow ? "active" : ""}`}
            onClick={() => setFollow((value) => !value)}
            aria-pressed={follow}
            title={
              follow
                ? "Tracing the latest node live — click to pin the view"
                : "View pinned — click to follow the latest node live"
            }
          >
            <span className="traceDot" aria-hidden="true" />
            Tracing
          </button>
          <button onClick={resetLayout} type="button">
            Auto layout
          </button>
        </div>
      </div>

      <div
        className={`mapCanvas ${autoLayouting ? "autoLayouting" : ""} ${hasFocus ? "hasFocus" : ""} ${
          nodeDrag ? "nodeDragging" : ""
        } ${follow ? "following" : ""}`}
        onPointerDown={beginSelectionDrag}
        ref={mapRef}
        style={
          {
            "--tree-scale": appliedScale,
            "--tree-pan-x": `${pan.x}px`,
            "--tree-pan-y": `${pan.y}px`,
            "--tree-render-width": `${Math.round(treeMetrics.width * appliedScale)}px`,
            "--tree-render-height": `${Math.round(treeMetrics.height * appliedScale)}px`
          } as CSSProperties
        }
      >
        <ConnectionLayer
          edges={measuredEdges}
          focusedFilePath={selectedFilePath}
          focusedStepId={focusedStepId}
          selectedAgentIsRoot={selectedAgentIsRoot}
          selectedAgentLabel={selectedAgentLabel}
          selectedEventId={selectedEventId}
          selectedTreeFocus={selectedTreeFocus}
          treeEdges={measuredTreeEdges}
        />
        <div className="workflowTree">
          {steps.length === 0 ? (
            <div className="emptyWorkflow">
              <h3>No runs recorded yet</h3>
              <p className="muted">Run a coding agent in this project and the session map forms here, live.</p>
              <ol className="emptySteps">
                <li>
                  Start the recorder:
                  <code>npm run up -- --project &lt;your-project&gt;</code>
                </li>
                <li>
                  Run your agent in that project:
                  <code>AGENT_BLACKBOX_DAEMON_URL={daemonUrl} opencode run "Read the code, run the tests, and summarize."</code>
                </li>
                <li>This view updates automatically as events arrive — no refresh needed.</li>
              </ol>
              <p className="emptyHint muted">Listening at {daemonUrl}</p>
            </div>
          ) : (
            <WorkflowTree
              agentNodes={agentNodes}
              nodeOffsets={nodeOffsets}
              layout={treeLayout}
              metrics={treeMetrics}
              onBeginNodeDrag={beginNodeDrag}
              onSelectEvent={onSelectEvent}
              selectedAgentIsRoot={selectedAgentIsRoot}
              selectedAgentLabel={selectedAgentLabel}
              selectedEventId={selectedEventId}
              selectedFileStepIds={selectedFileStepIds}
              selectedFilePath={selectedFilePath}
              selectedNodeIds={selectedNodeIds}
            />
          )}
        </div>
        {selectionBox ? (
          <div
            className="selectionBox"
            style={
              {
                height: selectionBox.height,
                left: selectionBox.left,
                top: selectionBox.top,
                width: selectionBox.width
              } as CSSProperties
            }
          />
        ) : null}
        {showInspector && momentAnchor ? (
          <GlassInspector
            agentDetail={agentDetail}
            anchor={momentAnchor}
            connections={fileConnections}
            onSelectSeq={onSelectSeq}
            selectedBranch={selectedBranch}
            selectedEvent={selectedEvent}
            selectedFilePath={selectedFilePath}
            selectedStep={selectedStep}
          />
        ) : null}
      </div>
    </section>
  );
}

function WorkflowTree({
  agentNodes,
  layout,
  metrics,
  nodeOffsets,
  onBeginNodeDrag,
  onSelectEvent,
  selectedAgentIsRoot,
  selectedAgentLabel,
  selectedEventId,
  selectedFileStepIds,
  selectedFilePath,
  selectedNodeIds
}: {
  agentNodes: WorkflowNode[];
  layout: AgentTreeLayout;
  metrics: TreeLayoutMetrics;
  nodeOffsets: NodeOffsetMap;
  onBeginNodeDrag: (event: ReactPointerEvent<HTMLElement>, item: AgentTreeItem) => void;
  onSelectEvent: (eventId: string) => void;
  selectedAgentIsRoot: boolean;
  selectedAgentLabel: string | null;
  selectedEventId: string | null;
  selectedFileStepIds: Set<string>;
  selectedFilePath: string | null;
  selectedNodeIds: Set<string>;
}) {
  const agentStatusByLabel = useMemo(() => {
    const statuses = new Map<string, WorkflowNode["status"]>();
    for (const node of agentNodes) {
      statuses.set(node.label, node.status);
    }
    return statuses;
  }, [agentNodes]);
  const rootIndexByStepId = useMemo(() => {
    const indexes = new Map<string, number>();
    layout.items
      .filter((item): item is AgentTreeItem & { type: "step" } => item.type === "step" && item.laneId === "root")
      .forEach((item, index) => indexes.set(item.step.id, index + 1));
    return indexes;
  }, [layout]);

  return (
    <div
      className="treeGrid fit"
      style={
        {
          "--tree-rows": layout.rowCount,
          height: metrics.height,
          width: metrics.width
        } as CSSProperties
      }
    >
      {layout.items.map((item) => (
        <TreeItemCard
          agentStatus={item.type === "step" && item.step.agentLabel ? agentStatusByLabel.get(item.step.agentLabel) : undefined}
          item={item}
          key={item.id}
          markerLabel={item.type === "step" && item.laneId === "root" ? String(rootIndexByStepId.get(item.step.id) ?? "") : ""}
          metrics={metrics}
          nodeOffset={nodeOffsets[item.id] ?? { x: 0, y: 0 }}
          onBeginNodeDrag={onBeginNodeDrag}
          onSelectEvent={onSelectEvent}
          selectedAgentIsRoot={selectedAgentIsRoot}
          selectedAgentLabel={selectedAgentLabel}
          selectedEventId={selectedEventId}
          selectedFileStepIds={selectedFileStepIds}
          selectedFilePath={selectedFilePath}
          selectedNodeIds={selectedNodeIds}
        />
      ))}
    </div>
  );
}

function TreeItemCard({
  agentStatus,
  item,
  markerLabel,
  metrics,
  nodeOffset,
  onBeginNodeDrag,
  onSelectEvent,
  selectedAgentIsRoot,
  selectedAgentLabel,
  selectedEventId,
  selectedFileStepIds,
  selectedFilePath,
  selectedNodeIds
}: {
  agentStatus: WorkflowNode["status"] | undefined;
  item: AgentTreeItem;
  markerLabel: string;
  metrics: TreeLayoutMetrics;
  nodeOffset: Point;
  onBeginNodeDrag: (event: ReactPointerEvent<HTMLElement>, item: AgentTreeItem) => void;
  onSelectEvent: (eventId: string) => void;
  selectedAgentIsRoot: boolean;
  selectedAgentLabel: string | null;
  selectedEventId: string | null;
  selectedFileStepIds: Set<string>;
  selectedFilePath: string | null;
  selectedNodeIds: Set<string>;
}) {
  const position = treeItemPosition(item, metrics);
  const style = {
    transform: `translate3d(${position.x + nodeOffset.x}px, ${position.y + nodeOffset.y}px, 0)`,
    "--node-width": `${position.width}px`
  } as CSSProperties;
  const manuallySelected = selectedNodeIds.has(item.id);
  const agentLabel = item.type === "step" ? item.step.agentLabel : item.branch.label;
  const agentFocused = Boolean(
    selectedAgentLabel && ((selectedAgentIsRoot && item.laneId === "root") || agentLabel === selectedAgentLabel)
  );
  const fileFocused = item.type === "step" && selectedFileStepIds.has(item.step.id);
  if (item.type === "agent-start") {
    const selected = !selectedFilePath && item.branch.eventId === selectedEventId;
    return (
      <button
        aria-label={`${item.branch.title}. ${item.branch.label}.`}
        className={`treeNode agentStartCard tone-${item.branch.tone} ${selected ? "selected" : ""} ${
          manuallySelected ? "manualSelected" : ""
        } ${agentFocused ? "agentFocused" : ""} ${fileFocused ? "fileFocused" : ""}`}
        data-agent-label={item.branch.label}
        data-tree-node-id={item.id}
        onPointerDown={(event) => onBeginNodeDrag(event, item)}
        style={style}
        type="button"
      >
        <span className="agentStemDot" />
        <span className="agentStartText">
          <span>{item.branch.detail ?? "agent"}</span>
          <strong>{shortTitle(item.branch.label)}</strong>
        </span>
      </button>
    );
  }

  const step = item.step;
  const selected =
    !selectedFilePath && (step.eventId === selectedEventId || step.branches.some((branch) => branch.eventId === selectedEventId));
  const fileCount = uniqueFileCount(step);
  return (
    <button
      aria-label={`${stepDisplayTitle(step, fileCount)}. ${formatTokenCount(step.tokens.total)}. ${fileCount} connected files.`}
      className={`treeNode spineStep treeStep tone-${step.tone} ${step.agentLabel ? "agentStep" : "rootStep"} ${
        selected ? "selected" : ""
      } ${manuallySelected ? "manualSelected" : ""} ${agentFocused ? "agentFocused" : ""} ${
        fileFocused ? "fileFocused" : ""
      }`}
      data-agent-label={step.agentLabel ?? "main"}
      data-step-id={step.id}
      data-tree-node-id={item.id}
      onPointerDown={(event) => onBeginNodeDrag(event, item)}
      style={style}
      type="button"
    >
      <span className={step.agentLabel ? "stepMarker agentMarker" : "stepMarker"}>{markerLabel}</span>
      <span className="stepMain">
        {step.agentLabel ? (
          <span className="agentPill">
            {shortTitle(step.agentName ?? step.agentLabel)}
            {agentStatus ? <span>{agentStatus.toLowerCase()}</span> : null}
          </span>
        ) : null}
        <strong>{shortTitle(stepDisplayTitle(step, fileCount))}</strong>
        {step.tokens.total > 0 || fileCount > 0 ? (
          <span className="stepInlineStats">
            {step.tokens.total > 0 ? formatTokenNumber(step.tokens.total) : null}
            {step.tokens.total > 0 && fileCount > 0 ? " · " : null}
            {fileCount > 0 ? `${fileCount} ${fileCount === 1 ? "file" : "files"}` : null}
          </span>
        ) : null}
      </span>
      <span className="stepBadges">
        <span className="tokenPill">{formatTokenNumber(step.tokens.total)}</span>
        <span className="stepCount">{fileCount}</span>
      </span>
    </button>
  );
}

function ConnectionLayer({
  edges,
  focusedFilePath,
  focusedStepId,
  selectedAgentIsRoot,
  selectedAgentLabel,
  selectedEventId,
  selectedTreeFocus,
  treeEdges
}: {
  edges: MeasuredEdge[];
  focusedFilePath: string | null;
  focusedStepId: string | null;
  selectedAgentIsRoot: boolean;
  selectedAgentLabel: string | null;
  selectedEventId: string | null;
  selectedTreeFocus: SelectedTreeFocus;
  treeEdges: MeasuredTreeEdge[];
}) {
  const selectedLaneId = selectedAgentLabel ? agentLaneIdForLabel(selectedAgentLabel) : null;
  return (
    <svg className="connectionLayer" aria-hidden="true">
      {treeEdges.map((edge) => {
        const focused =
          selectedTreeFocus.nodeIds.has(edge.fromNodeId) ||
          selectedTreeFocus.nodeIds.has(edge.toNodeId) ||
          selectedTreeFocus.eventIds.has(edge.eventId) ||
          (focusedStepId !== null && (edge.fromNodeId.includes(focusedStepId) || edge.toNodeId.includes(focusedStepId))) ||
          (selectedAgentIsRoot && edge.laneId === "root") ||
          (selectedLaneId !== null && edge.laneId === selectedLaneId) ||
          edge.eventId === selectedEventId;
        return (
          <path
            className={`treeEdge treeEdge-${edge.kind} ${focused ? "focused" : ""}`}
            d={edge.pathD}
            key={edge.id}
          />
        );
      })}
      {edges.map((edge) => {
        const focused =
          selectedTreeFocus.stepIds.has(edge.stepId) ||
          selectedTreeFocus.eventIds.has(edge.eventId) ||
          (focusedFilePath !== null && edge.path === focusedFilePath) ||
          (focusedStepId !== null && edge.stepId === focusedStepId) ||
          (selectedAgentIsRoot && !edge.agentLabel) ||
          (selectedAgentLabel !== null && edge.agentLabel === selectedAgentLabel) ||
          edge.eventId === selectedEventId;
        return <path className={focused ? "mapEdge focused" : "mapEdge"} d={edge.pathD} key={edge.id} />;
      })}
    </svg>
  );
}

function treeConnectionPath(
  fromRect: DOMRect,
  toRect: DOMRect,
  containerRect: DOMRect,
  kind: AgentTreeConnection["kind"]
): string {
  if (kind !== "branch") {
    const startX = fromRect.left + fromRect.width / 2 - containerRect.left;
    const startY = fromRect.bottom - containerRect.top;
    const endX = toRect.left + toRect.width / 2 - containerRect.left;
    const endY = toRect.top - containerRect.top;
    const midY = startY + Math.max(12, (endY - startY) / 2);
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  }

  const targetIsRight = toRect.left + toRect.width / 2 >= fromRect.left + fromRect.width / 2;
  const startX = (targetIsRight ? fromRect.right : fromRect.left) - containerRect.left;
  const startY = fromRect.top + fromRect.height / 2 - containerRect.top;
  const endX = (targetIsRight ? toRect.left : toRect.right) - containerRect.left;
  const endY = toRect.top + toRect.height / 2 - containerRect.top;
  const direction = targetIsRight ? 1 : -1;
  const bend = Math.max(28, Math.min(92, Math.abs(endX - startX) / 2));
  return `M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`;
}

function FileStructure({
  hasFocus,
  onResizeStart,
  onSelectFile,
  rows,
  selectedAgentIsRoot,
  selectedAgentLabel,
  selectedEventId,
  selectedFilePath,
  selectedStepId
}: {
  hasFocus: boolean;
  onResizeStart?: (clientX: number) => void;
  onSelectFile: (path: string) => void;
  rows: FileTreeRow[];
  selectedAgentIsRoot: boolean;
  selectedAgentLabel: string | null;
  selectedEventId: string | null;
  selectedFilePath: string | null;
  selectedStepId: string | null;
}) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const visibleRows = useMemo(() => visibleFileRows(rows, collapsedFolders), [rows, collapsedFolders]);
  const fileAnchors = useMemo(
    () => rows.filter((row): row is Extract<FileTreeRow, { type: "file" }> => row.type === "file"),
    [rows]
  );
  const itemCount = rows.filter((row) => row.type === "file").length;
  const toggleFolder = (path: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("agent-blackbox:layout"));
    });
  };

  return (
    <aside className={`fileStructure ${hasFocus ? "hasFocus" : ""}`} aria-label="Connected file structure">
      {onResizeStart ? (
        <button
          aria-label="Resize file list"
          className="resizeHandle"
          onPointerDown={(event) => {
            event.preventDefault();
            onResizeStart(event.clientX);
          }}
          type="button"
        />
      ) : null}
      <div className="finderChrome">
        <span />
        <span />
        <span />
      </div>
      <div className="fileHeader">
        <h2>Files</h2>
        <span>{itemCount} items</span>
      </div>
      <div className="finderColumns" aria-hidden="true">
        <span>Name</span>
        <span>Links</span>
        <span>Last</span>
      </div>
      <div className="fileAnchorRail" aria-hidden="true">
        {fileAnchors.map((row, index) => {
          const focus = fileFocusState({
            connections: row.connections,
            path: row.path,
            selectedAgentIsRoot,
            selectedAgentLabel,
            selectedEventId,
            selectedFilePath,
            selectedStepId
          });
          return (
            <span
              className={`fileAnchorTick ${focus.selected ? "selected" : ""} ${focus.linked ? "linked" : ""} ${
                focus.agentLinked ? "agentLinked" : ""
              } ${focus.eventLinked ? "eventLinked" : ""}`}
              data-file-anchor-path={row.path}
              key={row.path}
              style={{ top: `${fileAnchorTop(index, fileAnchors.length)}%` } as CSSProperties}
            />
          );
        })}
      </div>
      <div className="fileRows">
        {rows.length === 0 ? <p className="muted">No connected files yet.</p> : null}
        {visibleRows.map((row) =>
          row.type === "folder" ? (
            <button
              aria-expanded={!collapsedFolders.has(row.path)}
              className={`finderRow folderRow ${row.level === 0 ? "rootRow" : ""}`}
              key={row.id}
              onClick={() => toggleFolder(row.path)}
              style={{ "--depth": `${row.level * 14}px` } as CSSProperties}
              type="button"
            >
              <span className="finderName">
                <span className={collapsedFolders.has(row.path) ? "disclosure collapsed" : "disclosure"} />
                <span className="folderGlyph" />
                <strong>{row.name}</strong>
              </span>
              <span>-</span>
              <span>-</span>
            </button>
          ) : (
            <FileRow
              key={row.id}
              onSelectFile={onSelectFile}
              row={row}
              selectedAgentIsRoot={selectedAgentIsRoot}
              selectedAgentLabel={selectedAgentLabel}
              selectedEventId={selectedEventId}
              selectedFilePath={selectedFilePath}
              selectedStepId={selectedStepId}
            />
          )
        )}
      </div>
    </aside>
  );
}

function FileRow({
  onSelectFile,
  row,
  selectedAgentIsRoot,
  selectedAgentLabel,
  selectedEventId,
  selectedFilePath,
  selectedStepId
}: {
  onSelectFile: (path: string) => void;
  row: Extract<FileTreeRow, { type: "file" }>;
  selectedAgentIsRoot: boolean;
  selectedAgentLabel: string | null;
  selectedEventId: string | null;
  selectedFilePath: string | null;
  selectedStepId: string | null;
}) {
  const focus = fileFocusState({
    connections: row.connections,
    path: row.path,
    selectedAgentIsRoot,
    selectedAgentLabel,
    selectedEventId,
    selectedFilePath,
    selectedStepId
  });
  return (
    <button
      className={`finderRow fileNode ${row.level === 0 ? "rootRow" : ""} ${
        focus.selected ? "selected" : ""
      } ${focus.linked ? "linked" : ""} ${focus.agentLinked ? "agentLinked" : ""} ${
        focus.eventLinked ? "eventLinked" : ""
      }`}
      data-file-path={row.path}
      onClick={() => onSelectFile(row.path)}
      style={{ "--depth": `${row.level * 14}px` } as CSSProperties}
      type="button"
    >
      <span className="finderName">
        <span className="disclosure placeholder" />
        <span className="fileGlyph" />
        <strong>{row.name}</strong>
      </span>
      <span>{row.connections.length}</span>
      <span>seq {latestConnectionSeq(row.connections)}</span>
    </button>
  );
}

type FileFocusState = {
  selected: boolean;
  linked: boolean;
  agentLinked: boolean;
  eventLinked: boolean;
};

function fileFocusState({
  connections,
  path,
  selectedAgentIsRoot,
  selectedAgentLabel,
  selectedEventId,
  selectedFilePath,
  selectedStepId
}: {
  connections: FileConnection[];
  path: string;
  selectedAgentIsRoot: boolean;
  selectedAgentLabel: string | null;
  selectedEventId: string | null;
  selectedFilePath: string | null;
  selectedStepId: string | null;
}): FileFocusState {
  return {
    selected: path === selectedFilePath,
    linked: Boolean(selectedStepId && connections.some((connection) => connection.stepId === selectedStepId)),
    agentLinked: Boolean(
      selectedAgentLabel &&
        connections.some((connection) =>
          selectedAgentIsRoot ? connection.agentLabel === undefined : connection.agentLabel === selectedAgentLabel
        )
    ),
    eventLinked: Boolean(selectedEventId && connections.some((connection) => connection.eventId === selectedEventId))
  };
}

function fileAnchorTop(index: number, count: number): number {
  if (count <= 1) return 50;
  return 8 + (index / (count - 1)) * 84;
}

type AgentDetail = {
  commands: number;
  files: string[];
  label: string;
  moments: number;
  role: string;
  status: WorkflowNode["status"] | null;
};

function GlassInspector({
  agentDetail,
  anchor,
  connections,
  onSelectSeq,
  selectedBranch,
  selectedEvent,
  selectedFilePath,
  selectedStep
}: {
  agentDetail: AgentDetail | null;
  anchor: { left: number; top: number };
  connections: FileConnection[];
  onSelectSeq: (seq: number) => void;
  selectedBranch: WorkflowBranch | null;
  selectedEvent: TraceEvent | null;
  selectedFilePath: string | null;
  selectedStep: WorkflowStep | null;
}) {
  if (agentDetail) {
    return (
      <aside className="glassInspector" aria-label="Agent detail" style={{ left: anchor.left, top: anchor.top } as CSSProperties}>
        <span className="glassKicker">{agentDetail.role}</span>
        <strong>{agentDetail.label}</strong>
        <p>
          {agentDetail.status ? `${agentDetail.status.toLowerCase()} · ` : ""}
          {agentDetail.moments} {agentDetail.moments === 1 ? "moment" : "moments"} on this lane
          {agentDetail.commands > 0 ? ` · ${agentDetail.commands} verifications` : ""}
          {agentDetail.files.length > 0 ? `. Touched ${agentDetail.files.map(fileNameFromPath).join(", ")}.` : "."}
        </p>
        <div className="glassMeta">
          {agentDetail.status ? <span>{agentDetail.status.toLowerCase()}</span> : null}
          <span>
            {agentDetail.moments} {agentDetail.moments === 1 ? "moment" : "moments"}
          </span>
          <span>
            {agentDetail.files.length} {agentDetail.files.length === 1 ? "file" : "files"}
          </span>
        </div>
        {selectedBranch?.seq ? (
          <button onClick={() => onSelectSeq(selectedBranch.seq)} type="button">
            Replay
          </button>
        ) : null}
      </aside>
    );
  }

  const fileConnections = selectedFilePath
    ? connections.filter((connection) => connection.path === selectedFilePath)
    : [];
  const latestFileConnection = fileConnections.at(-1);
  const stepTitle = selectedStep ? stepDisplayTitle(selectedStep, uniqueFileCount(selectedStep)) : undefined;
  const title = selectedFilePath
    ? fileNameFromPath(selectedFilePath)
    : selectedBranch?.title ?? stepTitle ?? "Nothing selected";
  const description = selectedFilePath
    ? `${fileConnections.length} workflow moments are connected to this file.`
    : selectedBranch?.description ??
      (selectedStep ? aggregatedStepDescription(selectedStep) : undefined) ??
      "Click a workflow moment or a file to focus its connection.";
  const seq = selectedFilePath ? latestFileConnection?.seq : selectedBranch?.seq ?? selectedStep?.seq;
  const showsFullPrompt = !selectedFilePath && (selectedBranch?.kind === "prompt" || selectedStep?.kind === "prompt");

  return (
    <aside
      className="glassInspector"
      aria-label="Focused detail"
      style={{ left: anchor.left, top: anchor.top } as CSSProperties}
    >
      <span className="glassKicker">{selectedFilePath ? "file focus" : selectedBranch ? selectedBranch.kind : "moment"}</span>
      <strong>{shortTitle(title)}</strong>
      <p className={showsFullPrompt ? "glassFullText" : undefined}>
        {showsFullPrompt ? description : compactDescription(description)}
      </p>
      <div className="glassMeta">
        {seq ? <span>seq {seq}</span> : null}
        <span>{selectedEvent?.evidence.observed ? "observed" : "mapped"}</span>
        {selectedFilePath ? <span>{fileConnections.length} links</span> : null}
        {!selectedFilePath && selectedStep ? <span>{formatTokenCount(selectedStep.tokens.total)}</span> : null}
      </div>
      {seq ? (
        <button onClick={() => onSelectSeq(seq)} type="button">
          Replay
        </button>
      ) : null}
    </aside>
  );
}

type FileConnection = {
  agentLabel?: string;
  id: string;
  stepId: string;
  eventId: string;
  path: string;
  seq: number;
  tone: WorkflowBranch["tone"];
};

type MeasuredEdge = FileConnection & {
  pathD: string;
};

type MeasuredTreeEdge = AgentTreeConnection & {
  pathD: string;
};

type Point = {
  x: number;
  y: number;
};

type RectLike = {
  height: number;
  left: number;
  top: number;
  width: number;
};

type TreeLayoutMetrics = {
  branchColumnWidth: number;
  columnGap: number;
  height: number;
  rootColumnWidth: number;
  rowGap: number;
  rowHeight: number;
  width: number;
};

type TreeItemPosition = {
  width: number;
  x: number;
  y: number;
};

type SelectedTreeFocus = {
  eventIds: Set<string>;
  nodeIds: Set<string>;
  stepIds: Set<string>;
};

type NodeOffsetMap = Record<string, Point>;

type NodeDrag = {
  additive: boolean;
  eventId: string;
  moved: boolean;
  nodeIds: string[];
  startOffsets: NodeOffsetMap;
  startX: number;
  startY: number;
};

type SelectionDrag = {
  additive: boolean;
  current: Point;
  start: Point;
};

type FileTreeRow =
  | {
      id: string;
      level: number;
      name: string;
      path: string;
      type: "folder";
    }
  | {
      connections: FileConnection[];
      id: string;
      level: number;
      name: string;
      path: string;
      type: "file";
    };

function createTreeLayoutMetrics(layout: AgentTreeLayout): TreeLayoutMetrics {
  const branchCount = Math.max(0, layout.columnCount - 1);
  const width =
    TREE_ROOT_COLUMN_WIDTH +
    (branchCount === 0 ? 0 : TREE_COLUMN_GAP + branchCount * TREE_BRANCH_COLUMN_WIDTH + (branchCount - 1) * TREE_COLUMN_GAP);
  const height = Math.max(TREE_ROW_HEIGHT, layout.rowCount * TREE_ROW_HEIGHT + Math.max(0, layout.rowCount - 1) * TREE_ROW_GAP);
  return {
    branchColumnWidth: TREE_BRANCH_COLUMN_WIDTH,
    columnGap: TREE_COLUMN_GAP,
    height,
    rootColumnWidth: TREE_ROOT_COLUMN_WIDTH,
    rowGap: TREE_ROW_GAP,
    rowHeight: TREE_ROW_HEIGHT,
    width
  };
}

function treeItemPosition(item: AgentTreeItem, metrics: TreeLayoutMetrics): TreeItemPosition {
  const branchIndex = Math.max(0, item.column - 2);
  const x =
    item.column === 1
      ? 0
      : metrics.rootColumnWidth + metrics.columnGap + branchIndex * (metrics.branchColumnWidth + metrics.columnGap);
  return {
    width: item.column === 1 ? metrics.rootColumnWidth : metrics.branchColumnWidth,
    x,
    y: (item.row - 1) * (metrics.rowHeight + metrics.rowGap)
  };
}

function createSelectedTreeFocus(items: AgentTreeItem[], selectedNodeIds: Set<string>): SelectedTreeFocus {
  const eventIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const item of items) {
    if (!selectedNodeIds.has(item.id)) continue;
    if (item.type === "step") {
      stepIds.add(item.step.id);
      eventIds.add(item.step.eventId);
      item.step.branches.forEach((branch) => eventIds.add(branch.eventId));
    } else {
      eventIds.add(item.branch.eventId);
    }
  }
  return {
    eventIds,
    nodeIds: new Set(selectedNodeIds),
    stepIds
  };
}

function createFileConnections(steps: WorkflowStep[]): FileConnection[] {
  return steps.flatMap((step) =>
    step.branches
      .filter((branch) => branch.kind === "file")
      .map((branch) => ({
        ...(step.agentLabel ? { agentLabel: step.agentLabel } : {}),
        id: `${step.id}-${branch.id}`,
        stepId: step.id,
        eventId: branch.eventId,
        path: normalizedProjectPath(branch.label),
        seq: branch.seq,
        tone: branch.tone
      }))
  );
}

function createFileRows(connections: FileConnection[]): FileTreeRow[] {
  const folderIds = new Set<string>();
  const fileMap = new Map<string, FileConnection[]>();

  for (const connection of connections) {
    const segments = pathSegments(connection.path);
    segments.slice(0, -1).forEach((_, index) => {
      folderIds.add(segments.slice(0, index + 1).join("/"));
    });
    const current = fileMap.get(connection.path) ?? [];
    current.push(connection);
    fileMap.set(connection.path, current);
  }

  const rows: FileTreeRow[] = [];
  if (fileMap.size === 0) {
    return rows;
  }

  rows.push({
    id: "folder-project-root",
    level: 0,
    name: "project",
    path: "",
    type: "folder"
  });

  const rootFiles = [...fileMap.entries()]
    .filter(([path]) => pathSegments(path).length === 1)
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [path, pathConnections] of rootFiles) {
    const segments = pathSegments(path);
    rows.push({
      connections: pathConnections,
      id: `file-${path}`,
      level: 1,
      name: segments[0] ?? path,
      path,
      type: "file"
    });
  }

  for (const folderPath of [...folderIds].sort((a, b) => a.localeCompare(b))) {
    const segments = folderPath.split("/");
    rows.push({
      id: `folder-${folderPath}`,
      level: segments.length,
      name: segments.at(-1) ?? folderPath,
      path: folderPath,
      type: "folder"
    });
    for (const [path, pathConnections] of [...fileMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const segmentsForPath = pathSegments(path);
      const parentFolder = segmentsForPath.slice(0, -1).join("/");
      if (parentFolder !== folderPath) continue;
      rows.push({
        connections: pathConnections,
        id: `file-${path}`,
        level: segments.length + 1,
        name: segmentsForPath.at(-1) ?? path,
        path,
        type: "file"
      });
    }
  }

  return rows;
}

function visibleFileRows(rows: FileTreeRow[], collapsedFolders: Set<string>): FileTreeRow[] {
  return rows.filter((row) => {
    if (row.type === "folder") {
      return !folderAncestors(row.path).some((path) => collapsedFolders.has(path));
    }
    return !fileFolderAncestors(row.path).some((path) => collapsedFolders.has(path));
  });
}

function folderAncestors(path: string): string[] {
  if (path.length === 0) return [];
  const segments = pathSegments(path);
  return ["", ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"))];
}

function fileFolderAncestors(path: string): string[] {
  const segments = pathSegments(path);
  return ["", ...segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"))];
}

function uniqueFileCount(step: WorkflowStep): number {
  return new Set(step.branches.filter((branch) => branch.kind === "file").map((branch) => branch.label)).size;
}

// Inspector body for a moment: when it aggregates several files, list them so
// the operator can see exactly what "Created 12 files" covered.
function aggregatedStepDescription(step: WorkflowStep): string {
  if (step.kind === "change" || step.kind === "context") {
    const files = [...new Set(step.branches.filter((branch) => branch.kind === "file").map((branch) => branch.label))];
    if (files.length > 1) {
      return `${files.length} files: ${files.map(fileNameFromPath).join(", ")}`;
    }
  }
  if (step.kind === "verification" || step.kind === "risk") {
    const runs = step.branches.filter((branch) => branch.kind === "verification").length;
    if (runs > 1) {
      return `${step.description} (${runs} runs)`;
    }
  }
  return step.description;
}

// When consecutive identical moments are aggregated into one node, surface the
// count in the title so "Created a file" x6 reads as "Created 6 files".
function stepDisplayTitle(step: WorkflowStep, fileCount: number): string {
  if (step.kind === "context" && step.title.startsWith("Read") && fileCount > 1) {
    return `Read ${fileCount} files`;
  }
  if (step.kind === "change" && fileCount > 1) {
    const verb = step.title.startsWith("Created")
      ? "Created"
      : step.title.startsWith("Deleted")
        ? "Deleted"
        : "Changed";
    return `${verb} ${fileCount} files`;
  }
  if (step.kind === "verification" || step.kind === "risk") {
    const runs = step.branches.filter((branch) => branch.kind === "verification").length;
    if (runs > 1) return `${step.title} ×${runs}`;
  }
  if (step.kind === "coordination") {
    // Count only the tool/skill/todo evidence branches — file reads can attach to
    // the same moment as contextual branches and must not inflate the count.
    const runs = step.branches.filter((branch) => branch.kind === "evidence").length;
    if (runs > 1) return `${step.title} ×${runs}`;
  }
  return step.title;
}

function pathSegments(path: string): string[] {
  return normalizedProjectPath(path).split("/").filter(Boolean);
}

function normalizedProjectPath(path: string): string {
  return path.replace(/^\$PROJECT\/?/, "").replace(/^\/+/, "");
}

function fileNameFromPath(path: string): string {
  return pathSegments(path).at(-1) ?? path;
}

function latestConnectionSeq(connections: FileConnection[]): number {
  return Math.max(...connections.map((connection) => connection.seq));
}

function shortTitle(value: string): string {
  return value.length > 42 ? `${value.slice(0, 39)}...` : value;
}

// A lane's display name. A lane labelled from its subagent's first prompt (no
// concise spawn name) gets its role distilled at render time ("You are a
// literature-search specialist" → "literature-search specialist"), so even runs
// recorded before this still read as roles. A real name passes through untouched.
function agentDisplayName(agent: { label: string; data?: { agentName?: unknown } }): string {
  const raw = typeof agent.data?.agentName === "string" ? agent.data.agentName : agent.label;
  return shortTitle(roleFromPrompt(raw) ?? raw);
}

function compactDescription(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 88 ? `${normalized.slice(0, 85)}...` : normalized;
}

function rectFromPoints(start: Point, current: Point): RectLike {
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  return {
    height: Math.abs(current.y - start.y),
    left,
    top,
    width: Math.abs(current.x - start.x)
  };
}

function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
}

function requestLayoutMeasure() {
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event("agent-blackbox:layout"));
  });
}

function agentLaneIdForLabel(label: string): string {
  return `agent:${label}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ContextPanel({
  report,
  effectiveness,
  baseline,
  ruleFindings,
  suggestions,
  usage,
  aiProvider,
  aiLoading,
  adviceRequested,
  onRequestAdvice,
  onRequestAi,
  onOptimize,
  onSelectMetric,
  memoryFile
}: {
  report: EfficiencyReport;
  effectiveness: EffectivenessReport;
  baseline: BaselineComparison | null;
  ruleFindings: RuleFinding[];
  suggestions: Suggestion[];
  usage: TokenUsage;
  aiProvider: string | null;
  aiLoading: boolean;
  adviceRequested: boolean;
  onRequestAdvice: () => void;
  onRequestAi: () => void;
  onOptimize: () => void;
  onSelectMetric: (metric: EfficiencyMetric) => void;
  memoryFile: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tokensOpen, setTokensOpen] = useState(false);
  if (report.metrics.length === 0) return null;
  const suggestionByMetric = new Map(suggestions.map((s) => [s.metricId, s]));
  const fixCount = suggestions.length;
  // The worst two fixes ride up top, always visible — the headline advice.
  const topFixes = [...suggestions]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "bad" ? -1 : 1))
    .slice(0, 2);
  const tokenRows: [string, number][] = [
    ["input", usage.input],
    ["output", usage.output],
    ["reasoning", usage.reasoning],
    ["cache read", usage.cacheRead],
    ["cache write", usage.cacheWrite]
  ];
  return (
    <section className="contextPanel" aria-label="Context efficiency">
      <div className="contextHead">
        <strong className={`contextScoreBig status-${report.status}`}>{report.overallScore}</strong>
        <div className="contextHeadMeta">
          <h2>
            Context efficiency
            {report.archetype && report.archetype !== "unknown" && report.archetypeConfidence >= 0.55 ? (
              <span
                className="contextArchetype"
                aria-label={`Task type: ${report.archetype}`}
                title={`Scored as a ${report.archetype} task${report.archetypeSignals?.length ? ` — ${report.archetypeSignals.join("; ")}` : ""}. The yardstick adapts to the task type once the classification is confident.`}
              >
                {report.archetype}
              </span>
            ) : null}
          </h2>
          <span className="contextHeadline">
            {report.headline}
            {report.estimated ? " · est." : ""}
          </span>
          {effectiveness.confidence !== "low" ? (
            <span
              className={`contextEffectiveness status-${effectiveness.status}`}
              aria-label={`Outcome (separate from the efficiency score): ${effectiveness.label}, ${effectiveness.score} of 100, ${effectiveness.confidence} confidence`}
              title={`Did the task land? ${effectiveness.confidence}-confidence heuristic from outcome + verification + failure signals${effectiveness.signals.length ? `: ${effectiveness.signals.map((s) => s.label).join("; ")}` : ""}. Separate from efficiency (the ${report.overallScore} above) — a run can be efficient but fail, or wasteful but succeed.`}
            >
              <span className="contextEffCaption">outcome</span>
              <span className="contextEffLabel">{effectiveness.label}</span>
              <span className="contextEffScore">{effectiveness.score}</span>
            </span>
          ) : null}
          {baseline && baseline.verdict !== "insufficient" ? (
            <span
              className={`contextBaseline verdict-${baseline.verdict}`}
              aria-label={`Versus your past runs (${baseline.verdict}): ${baseline.note}`}
              title="Compared against your past runs of the same task type in this project."
            >
              {baseline.verdict === "better" ? "↑ " : baseline.verdict === "worse" ? "↓ " : "≈ "}
              {baseline.note}
            </span>
          ) : null}
        </div>
      </div>

      <div className="contextAi">
        <button className="optimizeButton" type="button" onClick={onOptimize} disabled={fixCount === 0}>
          <span className="optimizeButtonLabel">Optimize future runs</span>
          <span className="optimizeButtonHint">Write a reversible memory to {memoryFile} →</span>
        </button>
        <button
          className="contextAiButton"
          type="button"
          onClick={adviceRequested ? onRequestAi : onRequestAdvice}
          disabled={aiLoading || fixCount === 0}
        >
          {aiLoading ? "Sharpening…" : adviceRequested ? "Re-run suggestions" : "Generate advice"}
        </button>
        {adviceRequested && aiProvider ? (
          <span className="contextAiNote">
            {aiProvider === "deterministic"
              ? "No free/local model reachable — showing rule-based tips. Configure --suggest."
              : `Suggestions tailored by ${aiProvider} (free).`}
          </span>
        ) : null}
      </div>

      {ruleFindings.length > 0 ? (
        <div className="contextRules" aria-label="Custom rule checks">
          <p className="contextRulesLabel">Custom checks</p>
          {ruleFindings.map((finding) => (
            <div
              className={`contextRule severity-${finding.severity}`}
              key={finding.ruleId}
              title={`Rule: ${finding.ruleId}`}
              aria-label={`${finding.severity}: ${finding.message}${finding.offenders.length ? ` — ${finding.offenders.join(", ")}` : ""}`}
            >
              <span className="contextRuleMsg">
                {/* Text severity tag, not colour alone — distinguishable in forced-colors / for colour-blind users. */}
                <span className={`contextRuleSev sev-${finding.severity}`}>{finding.severity}</span>
                {finding.message}
              </span>
              {finding.offenders.length > 0 ? <span className="contextRuleOffenders">{finding.offenders.join(", ")}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {adviceRequested ? (
        topFixes.length > 0 ? (
          <div className="contextTopFixes">
            {topFixes.map((fix) => (
              <button
                className={`contextTopFix severity-${fix.severity}`}
                key={fix.metricId}
                type="button"
                onClick={() => {
                  const metric = report.metrics.find((m) => m.id === fix.metricId);
                  if (metric && metric.evidenceEventIds.length > 0) onSelectMetric(metric);
                  setExpandedId(fix.metricId);
                }}
              >
                <span className="contextTopFixTitle">{fix.title}</span>
                <span className="contextTopFixAction">{fix.action}</span>
                <span className="contextSuggestionSource">{fix.source === "llm" ? "AI" : "rule"}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="contextAllClear">No waste detected — this run used its context economically.</p>
        )
      ) : null}

      <div className="contextMetrics">
        {report.metrics.map((metric) => {
          const suggestion = adviceRequested ? suggestionByMetric.get(metric.id) : undefined;
          const actionable = Boolean(suggestion) || metric.evidenceEventIds.length > 0;
          const expanded = expandedId === metric.id;
          return (
            <div className="contextMetricWrap" key={metric.id}>
              <button
                className={`contextMetric status-${metric.status}${expanded ? " expanded" : ""}`}
                type="button"
                onClick={() => {
                  if (metric.evidenceEventIds.length > 0) onSelectMetric(metric);
                  setExpandedId((current) => (current === metric.id ? null : suggestion ? metric.id : null));
                }}
                disabled={!actionable}
                aria-expanded={suggestion ? expanded : undefined}
              >
                <span className="contextMetricTop">
                  <span className="contextMetricLabel">{metric.label}</span>
                  <span className="contextMetricValue">{metric.display}</span>
                </span>
                <span className="contextBar">
                  <span className="contextBarFill" style={{ width: `${metric.score}%` } as CSSProperties} />
                </span>
              </button>
              {expanded && suggestion ? (
                <p className={`contextSuggestion severity-${suggestion.severity}`}>
                  {suggestion.action}
                  <span className="contextSuggestionSource"> · {suggestion.source === "llm" ? "AI" : "rule"}</span>
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <button
        className="contextTokensToggle"
        type="button"
        onClick={() => setTokensOpen((open) => !open)}
        aria-expanded={tokensOpen}
      >
        <span>tokens</span>
        <span className="contextTokensTotal">{formatTokenNumber(usage.total)} {tokensOpen ? "▾" : "▸"}</span>
      </button>
      {tokensOpen ? (
        <div className="contextTokenRows">
          {tokenRows.map(([label, value]) => (
            <div className="tokenRow" key={label}>
              <span>{label}</span>
              <strong>{formatTokenNumber(value)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// Shape returned by the daemon's /optimize endpoints (mirror of OptimizeResult).
type OptimizePreview = {
  action: string;
  score: number | null;
  reclaimableTokens?: number;
  block: string | null;
  agentsMdPath: string;
  applied: boolean;
};

const shortenPath = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
};

// The actuator's UI: previews the exact AGENTS.md memory block ABB would write
// from the last run, and lets you apply or revert it — a real, reversible change,
// not just advice. Separate from the "Sharpen advice" suggestion flow on purpose.
function OptimizeModal({ onClose, runId }: { onClose: () => void; runId: string | null }) {
  const [preview, setPreview] = useState<OptimizePreview | null>(null);
  const [applied, setApplied] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "done" | "error" } | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "working" | "error">("loading");
  // Act on the run the dashboard is showing, not whichever is globally-latest — so
  // optimizing while several Claude Code sessions run at once targets the right one.
  const runQuery = runId ? `?runId=${encodeURIComponent(runId)}` : "";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${daemonUrl}/optimize${runQuery}`);
        const json = (await res.json()) as { ok: boolean; data?: OptimizePreview };
        if (cancelled) return;
        if (!json.ok || !json.data) throw new Error("daemon error");
        setPreview(json.data);
        setApplied(json.data.applied);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runQuery]);

  const act = async (mode: "apply" | "revert") => {
    setPhase("working");
    setNote(null);
    try {
      const res = await fetch(`${daemonUrl}/optimize/${mode}${runQuery}`, { method: "POST" });
      const json = (await res.json()) as { ok: boolean; data?: OptimizePreview };
      if (!json.ok || !json.data) throw new Error("daemon error");
      setApplied(json.data.applied);
      setNote({ text: json.data.action, tone: "done" });
      setPhase("ready");
    } catch {
      setNote({ text: "That didn’t go through — the daemon may have stopped. Try again.", tone: "error" });
      setPhase("ready");
    }
  };

  const hasBlock = Boolean(preview?.block);
  const reclaim = preview?.reclaimableTokens ?? 0;
  const working = phase === "working";
  // The daemon picks the file the run's host actually reads (CLAUDE.md for Claude
  // Code, AGENTS.md otherwise) and returns it on the preview — mirror it here.
  const memoryFile = preview?.agentsMdPath?.split(/[\\/]/).pop() || "AGENTS.md";

  return (
    <div
      className="optimizeOverlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
      role="presentation"
    >
      <aside className="optimizePanel" aria-label="Optimize future runs" aria-modal="true" role="dialog">
        <div className="optimizeHeader">
          <div className="optimizeHeaderText">
            <h2>Optimize future runs</h2>
            <p className="optimizeSub">
              Writes a cache-safe, reversible note to <code>{memoryFile}</code> that your agent reads on its{" "}
              <strong>next</strong> run — turning this run’s wasted context into a rule it won’t repeat. This is a real
              file change, not advice.
            </p>
          </div>
          <button className="optimizeClose" type="button" onClick={onClose} aria-label="Close" disabled={working}>
            ✕
          </button>
        </div>

        {phase === "loading" ? (
          <p className="optimizeStatus">Reading the last run…</p>
        ) : phase === "error" ? (
          <p className="optimizeStatus error">Couldn’t reach the daemon. Is it still running?</p>
        ) : !hasBlock ? (
          <p className="optimizeStatus">
            This run is already lean — there’s nothing worth pinning yet. Run a heavier task and reopen this.
          </p>
        ) : (
          <>
            <div className="optimizeMeta">
              <span className={`optimizeBadge ${applied ? "on" : "off"}`}>{applied ? "Applied" : "Not applied"}</span>
              {reclaim > 0 ? (
                <span className="optimizeReclaim">~{formatTokenNumber(reclaim)} tokens targeted / run</span>
              ) : null}
              <code className="optimizePath" title={preview?.agentsMdPath}>
                {shortenPath(preview?.agentsMdPath ?? "")}
              </code>
            </div>
            <p className="optimizeBlockLabel">What gets written</p>
            <pre className="optimizeBlock">{preview?.block}</pre>
          </>
        )}

        {note ? <p className={`optimizeStatus ${note.tone}`}>{note.text}</p> : null}

        <div className="optimizeFooter">
          {hasBlock && phase !== "loading" && phase !== "error" ? (
            <>
              <button className="optimizeApply" type="button" onClick={() => void act("apply")} disabled={working}>
                {working ? "Writing…" : applied ? "Update from latest run" : `Apply to ${memoryFile}`}
              </button>
              {applied ? (
                <button className="optimizeRevert" type="button" onClick={() => void act("revert")} disabled={working}>
                  Revert
                </button>
              ) : null}
            </>
          ) : null}
          <button className="optimizeCancel" type="button" onClick={onClose} disabled={working}>
            {applied ? "Close" : "Cancel"}
          </button>
        </div>
      </aside>
    </div>
  );
}

function latestTokenUsage(events: TraceEvent[]): TokenUsage {
  let usage = emptyTokenUsage();
  for (const event of events) {
    const next = tokenUsageFromEvent(event);
    if (next) {
      usage = next;
    }
  }
  return usage;
}

function deriveRunStatus(events: TraceEvent[]): "active" | "idle" | "error" {
  if (events.length === 0) return "idle";
  let latest = events[0]!;
  for (const event of events) {
    if (Date.parse(event.ts) >= Date.parse(latest.ts)) latest = event;
  }
  if (latest.kind === "session_error") return "error";
  if (latest.kind === "session_idle") return "idle";
  // A run with no fresh events is no longer active even if it never emitted an
  // explicit idle event (e.g. it was interrupted). Treat a quiet run as idle.
  const lastStamp = Date.parse(latest.ts);
  if (!Number.isNaN(lastStamp) && Date.now() - lastStamp > 20_000) return "idle";
  return "active";
}

function isRuntimeAgentNode(node: WorkflowNode): boolean {
  return node.type === "AGENT" && typeof node.data.agentId === "string";
}

function tokenUsageFromEvent(event: TraceEvent): TokenUsage | undefined {
  const hasTokens =
    eventPayloadPath(event, "properties.info.tokens") !== undefined ||
    eventPayloadPath(event, "properties.tokens") !== undefined ||
    eventPayloadPath(event, "tokens") !== undefined;
  if (!hasTokens) return undefined;
  return normalizeTokenUsage({
    input: numberAtEventPath(event, ["properties.info.tokens.input", "properties.tokens.input", "tokens.input"]) ?? 0,
    output: numberAtEventPath(event, ["properties.info.tokens.output", "properties.tokens.output", "tokens.output"]) ?? 0,
    reasoning:
      numberAtEventPath(event, ["properties.info.tokens.reasoning", "properties.tokens.reasoning", "tokens.reasoning"]) ?? 0,
    cacheRead:
      numberAtEventPath(event, [
        "properties.info.tokens.cache.read",
        "properties.tokens.cache.read",
        "tokens.cache.read",
        "properties.info.tokens.cacheRead",
        "properties.tokens.cacheRead",
        "tokens.cacheRead"
      ]) ?? 0,
    cacheWrite:
      numberAtEventPath(event, [
        "properties.info.tokens.cache.write",
        "properties.tokens.cache.write",
        "tokens.cache.write",
        "properties.info.tokens.cacheWrite",
        "properties.tokens.cacheWrite",
        "tokens.cacheWrite"
      ]) ?? 0,
    total: 0
  });
}

function sessionDisplayName(events: TraceEvent[], fallback: string | undefined): string {
  let latestTitle: string | undefined;
  let latestSlug: string | undefined;
  let firstPrompt: string | undefined;
  for (const event of events) {
    const title = stringAtEventPath(event, ["properties.info.title"]);
    const slug = stringAtEventPath(event, ["properties.info.slug"]);
    if (title && !/^new session\b/i.test(title)) {
      latestTitle = title;
    }
    if (slug) {
      latestSlug = slug;
    }
    // Claude Code has no session title — name the run after its first user prompt
    // (role/text at the payload top level), so the picker reads it, not a raw id.
    if (!firstPrompt && event.kind === "message") {
      const role = stringAtEventPath(event, ["properties.role", "properties.info.role", "role"]);
      const text = stringAtEventPath(event, ["properties.text", "properties.prompt", "text"]);
      if (role === "user" && text) {
        const oneLine = text.replace(/\s+/g, " ").trim();
        firstPrompt = oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
      }
    }
  }
  return latestTitle ?? latestSlug ?? firstPrompt ?? fallback ?? "waiting for daemon";
}

function formatTokenCount(value: number): string {
  return `${formatTokenNumber(value)} tokens`;
}

function formatTokenNumber(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000, 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${trimFixed(value / 1000, 1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
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

function stringAtEventPath(event: TraceEvent, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = eventPayloadPath(event, path);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function numberAtEventPath(event: TraceEvent, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = eventPayloadPath(event, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function eventPayloadPath(event: TraceEvent, path: string): unknown {
  let current: unknown = event.payload;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status status-${status.toLowerCase()}`}>{status}</span>;
}

function toStreamUrl(baseUrl: string): string {
  const url = new URL("/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
