import { materializeWorkflowGraph, type PromiseCheck, type TraceEvent, type WorkflowGraph, type WorkflowNode } from "@agent-blackbox/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  createAgentTreeLayout,
  createTimelineMarks,
  createWorkflowSteps,
  filterWorkflowStepsBySeq,
  type AgentTreeConnection,
  type AgentTreeItem,
  type AgentTreeLayout,
  type TokenUsage,
  type WorkflowBranch,
  type WorkflowStep
} from "../graphLayout.js";
import { filterEventsForRun, latestRunId } from "../runSelection.js";

const daemonUrl = import.meta.env.VITE_AGENT_BLACKBOX_DAEMON_URL ?? "http://127.0.0.1:47831";

const TREE_ROOT_COLUMN_WIDTH = 140;
const TREE_BRANCH_COLUMN_WIDTH = 104;
const TREE_COLUMN_GAP = 14;
const TREE_ROW_HEIGHT = 28;
const TREE_ROW_GAP = 8;
const TREE_MIN_SCALE = 0.12;

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { message: string };
};

type TraceSnapshot = {
  events: TraceEvent[];
  graph: WorkflowGraph;
  checks: PromiseCheck[];
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
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
        setSnapshot(payload.data);
        setError(null);
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
            setSnapshot(payload.data);
            setError(null);
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
    };
  }, [selectedSeq]);

  const activeRunId = useMemo(() => latestRunId(snapshot?.events ?? []), [snapshot]);
  const visibleEvents = useMemo(
    () => filterEventsForRun(snapshot?.events ?? [], activeRunId),
    [snapshot, activeRunId]
  );
  const graph = useMemo(
    () => (visibleEvents.length > 0 ? materializeWorkflowGraph(visibleEvents) : snapshot?.graph ?? null),
    [snapshot, visibleEvents]
  );
  const agentNodes = graph?.nodes.filter(isRuntimeAgentNode) ?? [];
  const selectedAgent = agentNodes.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedAgentLabel = selectedAgent?.label ?? null;
  const workflowSteps = useMemo(() => createWorkflowSteps(visibleEvents), [visibleEvents]);
  const tokenTotals = useMemo(() => latestTokenUsage(visibleEvents), [visibleEvents]);
  const sessionName = useMemo(() => sessionDisplayName(visibleEvents, graph?.runId), [visibleEvents, graph]);
  const orderedEvents = useMemo(() => [...visibleEvents].sort((a, b) => a.seq - b.seq), [visibleEvents]);
  const marks = useMemo(() => createTimelineMarks(orderedEvents), [orderedEvents]);
  const maxSeq = orderedEvents.at(-1)?.seq ?? 0;
  const replaySeq = selectedSeq ?? maxSeq;
  const replaySteps = useMemo(() => filterWorkflowStepsBySeq(workflowSteps, replaySeq), [workflowSteps, replaySeq]);
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

  return (
    <main className="shell">
      <header className="topbar">
        <strong>{sessionName}</strong>
        <span className="topbarBlock" aria-hidden="true" />
      </header>

      {error ? <div className="banner">Daemon unavailable: {error}</div> : null}

      <section className="workspace">
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
                <strong>{shortTitle(agent.label)}</strong>
                <span>{agent.type.toLowerCase()}</span>
              </span>
              <span className="laneBadges">
                <StatusBadge status={agent.status} />
              </span>
            </button>
          ))}
          <TokenPanel usage={tokenTotals} />
          <div className="timeline">
            <h2>Events</h2>
            <div className="replayControls">
              <input
                aria-label="Replay sequence"
                max={maxSeq}
                min={0}
                onChange={(event) => setSelectedSeq(Number(event.currentTarget.value))}
                type="range"
                value={replaySeq}
              />
              <button disabled={selectedSeq === null} onClick={() => setSelectedSeq(null)} type="button">
                Live
              </button>
            </div>
            <p className="replayLabel">
              {selectedSeq === null ? "Live replay" : `Seq ${replaySeq}`} / {maxSeq}
            </p>
            <div className="ticks">
              {marks.slice(-80).map((mark) => (
                <button
                  className={`tick tick-${mark.tone} ${mark.seq <= replaySeq ? "seen" : ""}`}
                  key={mark.id}
                  onClick={() => setSelectedSeq(mark.seq)}
                  title={`${mark.seq}. ${mark.label}`}
                  type="button"
                />
              ))}
            </div>
          </div>
        </aside>

        <SessionMap
          agentNodes={agentNodes}
          onClearFocus={clearFocus}
          onSelectEvent={selectWorkflowEvent}
          onSelectFile={selectFile}
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
      </section>
    </main>
  );
}

function SessionMap({
  agentNodes,
  onClearFocus,
  onSelectEvent,
  onSelectFile,
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
  onClearFocus: () => void;
  onSelectEvent: (eventId: string) => void;
  onSelectFile: (path: string) => void;
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
  const [filePanelWidth, setFilePanelWidth] = useState(252);
  const [resizeDrag, setResizeDrag] = useState<{ startWidth: number; startX: number } | null>(null);
  const [inspectorSize, setInspectorSize] = useState<InspectorSize>({ height: 142, width: 320 });
  const [inspectorResizeDrag, setInspectorResizeDrag] = useState<InspectorResizeDrag | null>(null);
  const [nodeOffsets, setNodeOffsets] = useState<NodeOffsetMap>({});
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  const [selectionDrag, setSelectionDrag] = useState<SelectionDrag | null>(null);
  const [autoLayouting, setAutoLayouting] = useState(false);
  const treeLayout = useMemo(() => createAgentTreeLayout(steps), [steps]);
  const treeMetrics = useMemo(() => createTreeLayoutMetrics(treeLayout), [treeLayout]);
  const [treeFitScale, setTreeFitScale] = useState(1);
  const selectedAgentIsRoot =
    selectedAgentLabel !== null && !treeLayout.lanes.some((lane) => lane.id !== "root" && lane.label === selectedAgentLabel);
  const fileConnections = useMemo(() => createFileConnections(steps), [steps]);
  const fileRows = useMemo(() => createFileRows(fileConnections), [fileConnections]);
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
    if (!resizeDrag) return undefined;

    const move = (event: PointerEvent) => {
      const delta = resizeDrag.startX - event.clientX;
      setFilePanelWidth(clamp(resizeDrag.startWidth + delta, 210, 440));
    };
    const stop = () => {
      setResizeDrag(null);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [resizeDrag]);

  useEffect(() => {
    if (!inspectorResizeDrag) return undefined;

    const move = (event: PointerEvent) => {
      const changesWidth = inspectorResizeDrag.edge === "left" || inspectorResizeDrag.edge === "top-left";
      const changesHeight = inspectorResizeDrag.edge === "top" || inspectorResizeDrag.edge === "top-left";
      const widthDelta = changesWidth ? inspectorResizeDrag.startX - event.clientX : 0;
      const heightDelta = changesHeight ? inspectorResizeDrag.startY - event.clientY : 0;
      setInspectorSize({
        width: clamp(inspectorResizeDrag.startWidth + widthDelta, 260, 560),
        height: clamp(inspectorResizeDrag.startHeight + heightDelta, 122, 420)
      });
      requestLayoutMeasure();
    };
    const stop = () => {
      setInspectorResizeDrag(null);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = inspectorResizeCursor(inspectorResizeDrag.edge);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    return () => {
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, [inspectorResizeDrag]);

  useEffect(() => {
    if (!nodeDrag) return undefined;

    let moved = false;
    const move = (event: PointerEvent) => {
      const dx = event.clientX - nodeDrag.startX;
      const dy = event.clientY - nodeDrag.startY;
      moved = moved || Math.abs(dx) > 2 || Math.abs(dy) > 2;
      if (!moved) return;
      const scaledDx = dx / treeFitScale;
      const scaledDy = dy / treeFitScale;
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
      if (!moved) {
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
  }, [nodeDrag, onSelectEvent, treeFitScale]);

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

  useLayoutEffect(() => {
    const container = mapRef.current;
    if (!container) return undefined;
    const treeElement = container.querySelector<HTMLElement>(".workflowTree");
    if (!treeElement) return undefined;

    const fitTree = () => {
      const viewportRect = treeElement.getBoundingClientRect();
      const reservedHeight = showInspector ? Math.min(inspectorSize.height + 22, viewportRect.height * 0.36) : 0;
      const availableWidth = Math.max(120, viewportRect.width - 8);
      const availableHeight = Math.max(120, viewportRect.height - reservedHeight - 8);
      const nextScale = clamp(
        Math.min(1, availableWidth / treeMetrics.width, availableHeight / treeMetrics.height),
        TREE_MIN_SCALE,
        1
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
  }, [inspectorSize, showInspector, treeMetrics.height, treeMetrics.width]);

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
        return [
          {
            ...connection,
            pathD: treeConnectionPath(
              fromElement.getBoundingClientRect(),
              toElement.getBoundingClientRect(),
              containerRect,
              connection.kind
            )
          }
        ];
      });
      setMeasuredTreeEdges(nextTreeEdges);
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
    filePanelWidth,
    inspectorSize,
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
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const isSelected = selectedNodeIds.has(item.id);
    const nextSelection = new Set(additive || isSelected ? selectedNodeIds : []);
    if (additive && isSelected && nextSelection.size > 1) {
      nextSelection.delete(item.id);
    } else {
      nextSelection.add(item.id);
    }
    const nodeIds = [...nextSelection];
    setSelectedNodeIds(nextSelection);
    setNodeDrag({
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
  const resetLayout = () => {
    setAutoLayouting(true);
    setSelectedNodeIds(new Set());
    onClearFocus();
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
          <button onClick={resetLayout} type="button">
            Auto layout
          </button>
        </div>
      </div>

      <div
        className={`mapCanvas ${autoLayouting ? "autoLayouting" : ""} ${hasFocus ? "hasFocus" : ""} ${
          nodeDrag ? "nodeDragging" : ""
        }`}
        onPointerDown={beginSelectionDrag}
        ref={mapRef}
        style={{ "--files-width": `${filePanelWidth}px`, "--tree-scale": treeFitScale } as CSSProperties}
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
              <h3>No workflow yet</h3>
              <p className="muted">Start an agent run and the session map will form here.</p>
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
        <FileStructure
          hasFocus={hasFocus}
          onResizeStart={(clientX) => setResizeDrag({ startWidth: filePanelWidth, startX: clientX })}
          onSelectFile={onSelectFile}
          rows={fileRows}
          selectedAgentIsRoot={selectedAgentIsRoot}
          selectedAgentLabel={selectedAgentLabel}
          selectedEventId={selectedEventId}
          selectedFilePath={selectedFilePath}
          selectedStepId={focusedStepId}
        />
        {showInspector ? (
          <GlassInspector
            connections={fileConnections}
            inspectorSize={inspectorSize}
            onResizeStart={(edge, clientX, clientY) =>
              setInspectorResizeDrag({
                edge,
                startHeight: inspectorSize.height,
                startWidth: inspectorSize.width,
                startX: clientX,
                startY: clientY
              })
            }
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
        } ${agentFocused ? "agentFocused" : ""} ${fileFocused ? "fileFocused" : ""} ${selected ? "expanded" : ""}`}
        data-agent-label={item.branch.label}
        data-tree-node-id={item.id}
        onClick={() => onSelectEvent(item.branch.eventId)}
        onPointerDown={(event) => onBeginNodeDrag(event, item)}
        style={style}
        type="button"
      >
        <span className="agentStemDot" />
        <span className="agentStartText">
          <span>{item.branch.detail ?? "agent"}</span>
          <strong>{shortTitle(item.branch.label)}</strong>
          {selected ? <span className="agentStartDetail">{compactDescription(item.branch.description)}</span> : null}
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
      aria-label={`${step.title}. ${formatTokenCount(step.tokens.total)}. ${fileCount} connected files.`}
      className={`treeNode spineStep treeStep tone-${step.tone} ${step.agentLabel ? "agentStep" : "rootStep"} ${
        selected ? "selected" : ""
      } ${manuallySelected ? "manualSelected" : ""} ${agentFocused ? "agentFocused" : ""} ${
        fileFocused ? "fileFocused" : ""
      } ${selected ? "expanded" : ""}`}
      data-agent-label={step.agentLabel ?? "main"}
      data-step-id={step.id}
      data-tree-node-id={item.id}
      onClick={() => onSelectEvent(step.eventId)}
      onPointerDown={(event) => onBeginNodeDrag(event, item)}
      style={style}
      type="button"
    >
      <span className={step.agentLabel ? "stepMarker agentMarker" : "stepMarker"}>{markerLabel}</span>
      <span className="stepMain">
        {step.agentLabel ? (
          <span className="agentPill">
            {shortTitle(step.agentLabel)}
            {agentStatus ? <span>{agentStatus.toLowerCase()}</span> : null}
          </span>
        ) : null}
        <strong>{shortTitle(step.title)}</strong>
        <span className="stepInlineStats">
          {formatTokenNumber(step.tokens.total)} · {fileCount} {fileCount === 1 ? "file" : "files"}
        </span>
        {selected ? <span className="stepSummary">{compactDescription(step.description)}</span> : null}
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
  onResizeStart: (clientX: number) => void;
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
      <button
        aria-label="Resize file list"
        className="resizeHandle"
        onPointerDown={(event) => {
          event.preventDefault();
          onResizeStart(event.clientX);
        }}
        type="button"
      />
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
        <span>Kind</span>
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
              <span>Folder</span>
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
      <span>{fileKindFromName(row.name)}</span>
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

function GlassInspector({
  connections,
  inspectorSize,
  onResizeStart,
  onSelectSeq,
  selectedBranch,
  selectedEvent,
  selectedFilePath,
  selectedStep
}: {
  connections: FileConnection[];
  inspectorSize: InspectorSize;
  onResizeStart: (edge: InspectorResizeEdge, clientX: number, clientY: number) => void;
  onSelectSeq: (seq: number) => void;
  selectedBranch: WorkflowBranch | null;
  selectedEvent: TraceEvent | null;
  selectedFilePath: string | null;
  selectedStep: WorkflowStep | null;
}) {
  const fileConnections = selectedFilePath
    ? connections.filter((connection) => connection.path === selectedFilePath)
    : [];
  const latestFileConnection = fileConnections.at(-1);
  const title = selectedFilePath
    ? fileNameFromPath(selectedFilePath)
    : selectedBranch?.title ?? selectedStep?.title ?? "Nothing selected";
  const description = selectedFilePath
    ? `${fileConnections.length} workflow moments are connected to this file.`
    : selectedBranch?.description ?? selectedStep?.description ?? "Click a workflow moment or a file to focus its connection.";
  const seq = selectedFilePath ? latestFileConnection?.seq : selectedBranch?.seq ?? selectedStep?.seq;
  const showsFullPrompt = !selectedFilePath && (selectedBranch?.kind === "prompt" || selectedStep?.kind === "prompt");

  return (
    <aside
      className="glassInspector"
      aria-label="Focused detail"
      style={{ height: inspectorSize.height, width: inspectorSize.width } as CSSProperties}
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
      <button
        aria-label="Resize focused detail from left"
        className="inspectorResizeHandle inspectorResizeHandle-left"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart("left", event.clientX, event.clientY);
        }}
        type="button"
      />
      <button
        aria-label="Resize focused detail from top"
        className="inspectorResizeHandle inspectorResizeHandle-top"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart("top", event.clientX, event.clientY);
        }}
        type="button"
      />
      <button
        aria-label="Resize focused detail from top left"
        className="inspectorResizeHandle inspectorResizeHandle-topLeft"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onResizeStart("top-left", event.clientX, event.clientY);
        }}
        type="button"
      />
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

type InspectorSize = {
  height: number;
  width: number;
};

type InspectorResizeEdge = "left" | "top" | "top-left";

type InspectorResizeDrag = {
  edge: InspectorResizeEdge;
  startHeight: number;
  startWidth: number;
  startX: number;
  startY: number;
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

function fileKindFromName(name: string): string {
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() : undefined;
  if (!extension) return "Document";
  const known: Record<string, string> = {
    css: "Stylesheet",
    html: "HTML",
    js: "JavaScript",
    json: "JSON",
    jsx: "React",
    md: "Markdown",
    ts: "TypeScript",
    tsx: "React",
    yaml: "YAML",
    yml: "YAML"
  };
  return known[extension] ?? extension.toUpperCase();
}

function shortTitle(value: string): string {
  return value.length > 42 ? `${value.slice(0, 39)}...` : value;
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

function inspectorResizeCursor(edge: InspectorResizeEdge): string {
  if (edge === "left") return "ew-resize";
  if (edge === "top") return "ns-resize";
  return "nwse-resize";
}

function agentLaneIdForLabel(label: string): string {
  return `agent:${label}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function TokenPanel({ usage }: { usage: TokenUsage }) {
  const rows = [
    ["input", usage.input],
    ["output", usage.output],
    ["reasoning", usage.reasoning],
    ["cache read", usage.cacheRead],
    ["cache write", usage.cacheWrite]
  ] as const;

  return (
    <section className="tokenPanel" aria-label="Token usage">
      <h2>Tokens</h2>
      <strong className="tokenTotal">{formatTokenCount(usage.total)}</strong>
      <div className="tokenRows">
        {rows.map(([label, value]) => (
          <div className="tokenRow" key={label}>
            <span>{label}</span>
            <strong>{formatTokenNumber(value)}</strong>
          </div>
        ))}
      </div>
    </section>
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
  for (const event of events) {
    const title = stringAtEventPath(event, ["properties.info.title"]);
    const slug = stringAtEventPath(event, ["properties.info.slug"]);
    if (title && !/^new session\b/i.test(title)) {
      latestTitle = title;
    }
    if (slug) {
      latestSlug = slug;
    }
  }
  return latestTitle ?? latestSlug ?? fallback ?? "waiting for daemon";
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

function StatusBadge({ status }: { status: WorkflowNode["status"] }) {
  return <span className={`status status-${status.toLowerCase()}`}>{status}</span>;
}

function toStreamUrl(baseUrl: string): string {
  const url = new URL("/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
