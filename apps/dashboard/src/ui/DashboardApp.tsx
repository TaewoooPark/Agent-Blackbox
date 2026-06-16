import type { PromiseCheck, TraceEvent, WorkflowGraph, WorkflowNode } from "@agent-blackbox/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
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

const daemonUrl = import.meta.env.VITE_AGENT_BLACKBOX_DAEMON_URL ?? "http://127.0.0.1:47831";

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

  const graph = snapshot?.graph ?? null;
  const agentNodes = graph?.nodes.filter((node) => node.type === "AGENT") ?? [];
  const visibleEvents = useMemo(() => snapshot?.events ?? [], [snapshot]);
  const workflowSteps = useMemo(() => createWorkflowSteps(visibleEvents), [visibleEvents]);
  const tokenTotals = useMemo(() => latestTokenUsage(snapshot?.events ?? []), [snapshot]);
  const sessionName = useMemo(() => sessionDisplayName(snapshot?.events ?? [], graph?.runId), [snapshot, graph]);
  const orderedEvents = useMemo(() => [...(snapshot?.events ?? [])].sort((a, b) => a.seq - b.seq), [snapshot]);
  const marks = useMemo(() => createTimelineMarks(orderedEvents), [orderedEvents]);
  const maxSeq = orderedEvents.at(-1)?.seq ?? 0;
  const replaySeq = selectedSeq ?? maxSeq;
  const replaySteps = useMemo(() => filterWorkflowStepsBySeq(workflowSteps, replaySeq), [workflowSteps, replaySeq]);
  const selectedStep =
    (selectedEventId
      ? replaySteps.find(
          (step) => step.eventId === selectedEventId || step.branches.some((branch) => branch.eventId === selectedEventId)
        )
      : undefined) ??
    replaySteps.at(-1) ??
    null;
  const selectedBranch =
    selectedStep && selectedEventId && selectedEventId !== selectedStep.eventId
      ? selectedStep.branches.find((branch) => branch.eventId === selectedEventId) ?? null
      : null;
  const inspectedEventId = selectedBranch?.eventId ?? selectedStep?.eventId ?? null;
  const selectedEvent = inspectedEventId ? visibleEvents.find((event) => event.id === inspectedEventId) ?? null : null;
  const selectWorkflowEvent = (eventId: string) => {
    setSelectedEventId(eventId);
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
              onClick={() => setSelectedAgentId(agent.id)}
              type="button"
            >
              <span>{agent.label}</span>
              <StatusBadge status={agent.status} />
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
          onSelectEvent={selectWorkflowEvent}
          onSelectFile={setSelectedFilePath}
          onSelectSeq={setSelectedSeq}
          replaySeq={replaySeq}
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
  onSelectEvent,
  onSelectFile,
  onSelectSeq,
  replaySeq,
  selectedBranch,
  selectedEvent,
  selectedEventId,
  selectedFilePath,
  selectedStep,
  steps
}: {
  agentNodes: WorkflowNode[];
  onSelectEvent: (eventId: string) => void;
  onSelectFile: (path: string) => void;
  onSelectSeq: (seq: number) => void;
  replaySeq: number;
  selectedBranch: WorkflowBranch | null;
  selectedEvent: TraceEvent | null;
  selectedEventId: string | null;
  selectedFilePath: string | null;
  selectedStep: WorkflowStep | null;
  steps: WorkflowStep[];
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const [filePanelWidth, setFilePanelWidth] = useState(286);
  const [resizeDrag, setResizeDrag] = useState<{ startWidth: number; startX: number } | null>(null);
  const treeLayout = useMemo(() => createAgentTreeLayout(steps), [steps]);
  const fileConnections = useMemo(() => createFileConnections(steps), [steps]);
  const fileRows = useMemo(() => createFileRows(fileConnections), [fileConnections]);
  const [measuredEdges, setMeasuredEdges] = useState<MeasuredEdge[]>([]);
  const [measuredTreeEdges, setMeasuredTreeEdges] = useState<MeasuredTreeEdge[]>([]);

  useEffect(() => {
    if (!resizeDrag) return undefined;

    const move = (event: PointerEvent) => {
      const delta = resizeDrag.startX - event.clientX;
      setFilePanelWidth(clamp(resizeDrag.startWidth + delta, 220, 480));
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
      container.querySelectorAll<HTMLElement>("[data-file-path]").forEach((element) => {
        const path = element.dataset.filePath;
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
        const endX = fileRect.left - containerRect.left;
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
            pathD: treeConnectionPath(fromElement.getBoundingClientRect(), toElement.getBoundingClientRect(), containerRect)
          }
        ];
      });
      setMeasuredTreeEdges(nextTreeEdges);
    };

    const frame = window.requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("agent-blackbox:layout", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("agent-blackbox:layout", measure);
    };
  }, [fileConnections, filePanelWidth, steps, selectedEventId, selectedFilePath, treeLayout]);

  const focusedStepId = selectedFilePath ? null : selectedStep?.id ?? null;

  return (
    <section className="sessionMap" aria-label="Session workflow map">
      <div className="workflowHeader">
        <div>
          <h2>Session Map</h2>
          <p>Main actions form the trunk. Agents fork into branches, then reconnect through files and decisions.</p>
        </div>
        <span>{steps.length} moments · {Math.max(0, treeLayout.lanes.length - 1)} branches</span>
      </div>

      <div
        className="mapCanvas"
        ref={mapRef}
        style={{ "--files-width": `${filePanelWidth}px` } as CSSProperties}
      >
        <ConnectionLayer
          edges={measuredEdges}
          focusedFilePath={selectedFilePath}
          focusedStepId={focusedStepId}
          selectedEventId={selectedEventId}
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
              layout={treeLayout}
              onSelectEvent={onSelectEvent}
              selectedEventId={selectedEventId}
              selectedFilePath={selectedFilePath}
            />
          )}
        </div>
        <FileStructure
          onResizeStart={(clientX) => setResizeDrag({ startWidth: filePanelWidth, startX: clientX })}
          onSelectFile={onSelectFile}
          rows={fileRows}
          selectedFilePath={selectedFilePath}
          selectedStepId={focusedStepId}
        />
        <GlassInspector
          connections={fileConnections}
          onSelectSeq={onSelectSeq}
          selectedBranch={selectedBranch}
          selectedEvent={selectedEvent}
          selectedFilePath={selectedFilePath}
          selectedStep={selectedStep}
        />
      </div>
    </section>
  );
}

function WorkflowTree({
  agentNodes,
  layout,
  onSelectEvent,
  selectedEventId,
  selectedFilePath
}: {
  agentNodes: WorkflowNode[];
  layout: AgentTreeLayout;
  onSelectEvent: (eventId: string) => void;
  selectedEventId: string | null;
  selectedFilePath: string | null;
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
  const branchColumnCount = Math.max(0, layout.columnCount - 1);
  const gridTemplateColumns =
    branchColumnCount === 0 ? "minmax(190px, 286px)" : `minmax(190px, 286px) repeat(${branchColumnCount}, minmax(0, 1fr))`;

  return (
    <div
      className={`treeGrid ${layout.columnCount > 4 ? "dense" : ""}`}
      style={
        {
          "--tree-rows": layout.rowCount,
          gridTemplateColumns
        } as CSSProperties
      }
    >
      {layout.items.map((item) => (
        <TreeItemCard
          agentStatus={item.type === "step" && item.step.agentLabel ? agentStatusByLabel.get(item.step.agentLabel) : undefined}
          item={item}
          key={item.id}
          markerLabel={item.type === "step" && item.laneId === "root" ? String(rootIndexByStepId.get(item.step.id) ?? "") : ""}
          onSelectEvent={onSelectEvent}
          selectedEventId={selectedEventId}
          selectedFilePath={selectedFilePath}
        />
      ))}
    </div>
  );
}

function TreeItemCard({
  agentStatus,
  item,
  markerLabel,
  onSelectEvent,
  selectedEventId,
  selectedFilePath
}: {
  agentStatus: WorkflowNode["status"] | undefined;
  item: AgentTreeItem;
  markerLabel: string;
  onSelectEvent: (eventId: string) => void;
  selectedEventId: string | null;
  selectedFilePath: string | null;
}) {
  const style = { gridColumn: item.column, gridRow: item.row } as CSSProperties;
  if (item.type === "agent-start") {
    const selected = !selectedFilePath && item.branch.eventId === selectedEventId;
    return (
      <button
        aria-label={`${item.branch.title}. ${item.branch.label}.`}
        className={`treeNode agentStartCard tone-${item.branch.tone} ${selected ? "selected" : ""}`}
        data-tree-node-id={item.id}
        onClick={() => onSelectEvent(item.branch.eventId)}
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
  const selected = !selectedFilePath && step.eventId === selectedEventId;
  const fileCount = uniqueFileCount(step);
  return (
    <button
      aria-label={`${step.title}. ${formatTokenCount(step.tokens.total)}. ${fileCount} connected files.`}
      className={`treeNode spineStep treeStep tone-${step.tone} ${step.agentLabel ? "agentStep" : "rootStep"} ${
        selected ? "selected" : ""
      }`}
      data-step-id={step.id}
      data-tree-node-id={item.id}
      onClick={() => onSelectEvent(step.eventId)}
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
      </span>
      <span className="stepBadges">
        <span className="tokenPill">{formatTokenCount(step.tokens.total)}</span>
        <span className="stepCount">{fileCount === 0 ? "no files" : `${fileCount} files`}</span>
      </span>
    </button>
  );
}

function ConnectionLayer({
  edges,
  focusedFilePath,
  focusedStepId,
  selectedEventId,
  treeEdges
}: {
  edges: MeasuredEdge[];
  focusedFilePath: string | null;
  focusedStepId: string | null;
  selectedEventId: string | null;
  treeEdges: MeasuredTreeEdge[];
}) {
  return (
    <svg className="connectionLayer" aria-hidden="true">
      {treeEdges.map((edge) => {
        const focused =
          (focusedStepId !== null && (edge.fromNodeId.includes(focusedStepId) || edge.toNodeId.includes(focusedStepId))) ||
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
          (focusedFilePath !== null && edge.path === focusedFilePath) ||
          (focusedStepId !== null && edge.stepId === focusedStepId) ||
          edge.eventId === selectedEventId;
        return <path className={focused ? "mapEdge focused" : "mapEdge"} d={edge.pathD} key={edge.id} />;
      })}
    </svg>
  );
}

function treeConnectionPath(fromRect: DOMRect, toRect: DOMRect, containerRect: DOMRect): string {
  const sameColumn = Math.abs(fromRect.left - toRect.left) < 12;
  if (sameColumn) {
    const startX = fromRect.left + fromRect.width / 2 - containerRect.left;
    const startY = fromRect.bottom - containerRect.top;
    const endX = toRect.left + toRect.width / 2 - containerRect.left;
    const endY = toRect.top - containerRect.top;
    const midY = startY + Math.max(12, (endY - startY) / 2);
    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  }

  const startX = fromRect.right - containerRect.left;
  const startY = fromRect.top + fromRect.height / 2 - containerRect.top;
  const endX = toRect.left - containerRect.left;
  const endY = toRect.top + toRect.height / 2 - containerRect.top;
  const bend = Math.max(28, Math.min(92, Math.abs(endX - startX) / 2));
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function FileStructure({
  onResizeStart,
  onSelectFile,
  rows,
  selectedFilePath,
  selectedStepId
}: {
  onResizeStart: (clientX: number) => void;
  onSelectFile: (path: string) => void;
  rows: FileTreeRow[];
  selectedFilePath: string | null;
  selectedStepId: string | null;
}) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const visibleRows = useMemo(() => visibleFileRows(rows, collapsedFolders), [rows, collapsedFolders]);
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
    <aside className="fileStructure" aria-label="Connected file structure">
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
            <button
              className={`finderRow fileNode ${row.level === 0 ? "rootRow" : ""} ${
                row.path === selectedFilePath ? "selected" : ""
              } ${
                selectedStepId && row.connections.some((connection) => connection.stepId === selectedStepId) ? "linked" : ""
              }`}
              data-file-path={row.path}
              key={row.id}
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
          )
        )}
      </div>
    </aside>
  );
}

function GlassInspector({
  connections,
  onSelectSeq,
  selectedBranch,
  selectedEvent,
  selectedFilePath,
  selectedStep
}: {
  connections: FileConnection[];
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
    <aside className="glassInspector" aria-label="Focused detail">
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

function createFileConnections(steps: WorkflowStep[]): FileConnection[] {
  return steps.flatMap((step) =>
    step.branches
      .filter((branch) => branch.kind === "file")
      .map((branch) => ({
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
