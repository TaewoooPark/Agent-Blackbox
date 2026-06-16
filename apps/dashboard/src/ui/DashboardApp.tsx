import type { PromiseCheck, TraceEvent, WorkflowGraph, WorkflowNode } from "@agent-blackbox/core";
import { useEffect, useMemo, useState } from "react";
import {
  createTimelineMarks,
  layoutGraphNodes,
  summarizeGraph,
  summarizeTraceEvent,
  visibleEventsForGraph
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
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
  const summary = useMemo(() => (graph ? summarizeGraph(graph) : null), [graph]);
  const positionedNodes = useMemo(() => (graph ? layoutGraphNodes(graph) : []), [graph]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId) ?? graph?.nodes[0] ?? null;
  const agentNodes = graph?.nodes.filter((node) => node.type === "AGENT") ?? [];
  const visibleEvents = useMemo(
    () => (snapshot && graph ? visibleEventsForGraph(snapshot.events, graph) : []),
    [snapshot, graph]
  );
  const marks = useMemo(() => createTimelineMarks(snapshot?.events ?? []), [snapshot]);
  const replaySeq = selectedSeq ?? visibleEvents.at(-1)?.seq ?? 0;
  const maxSeq = snapshot?.events.at(-1)?.seq ?? 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <strong>Agent-Blackbox</strong>
          <span>{summary?.runId ?? "waiting for daemon"}</span>
        </div>
        <div className="stats">
          <Metric label="events" value={summary?.events ?? 0} />
          <Metric label="nodes" value={summary?.nodes ?? 0} />
          <Metric label="edges" value={summary?.edges ?? 0} />
          <Metric label="decisions" value={summary?.decisions ?? 0} />
          <Metric label="active" value={summary?.activeAgents ?? 0} />
          <Metric label="failures" value={summary?.failures ?? 0} tone={summary?.failures ? "risk" : "ok"} />
        </div>
      </header>

      {error ? <div className="banner">Daemon unavailable: {error}</div> : null}

      <section className="workspace">
        <aside className="lanes" aria-label="Agent lanes">
          <h2>Agents</h2>
          {agentNodes.length === 0 ? <p className="muted">No agent lanes yet.</p> : null}
          {agentNodes.map((agent) => (
            <button
              className={agent.id === selectedNode?.id ? "lane active" : "lane"}
              key={agent.id}
              onClick={() => setSelectedNodeId(agent.id)}
              type="button"
            >
              <span>{agent.label}</span>
              <StatusBadge status={agent.status} />
            </button>
          ))}
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

        <section className="graphPanel" aria-label="Workflow graph">
          <div className="graphCanvas">
            {graph?.edges.map((edge) => {
              const from = positionedNodes.find((node) => node.id === edge.from);
              const to = positionedNodes.find((node) => node.id === edge.to);
              if (!from || !to) return null;
              return (
                <svg className="edgeLayer" key={edge.id}>
                  <line
                    className={edge.inferred ? "edge inferred" : "edge"}
                    x1={from.x + 76}
                    x2={to.x + 76}
                    y1={from.y + 20}
                    y2={to.y + 20}
                  />
                </svg>
              );
            })}
            {positionedNodes.map((node) => (
              <button
                className={`node node-${node.type.toLowerCase()} ${node.id === selectedNode?.id ? "selected" : ""}`}
                key={node.id}
                onClick={() => setSelectedNodeId(node.id)}
                style={{ left: node.x, top: node.y }}
                type="button"
              >
                <span className="nodeType">{node.type}</span>
                <span className="nodeLabel">{node.label}</span>
                <StatusBadge status={node.status} />
              </button>
            ))}
          </div>
        </section>

        <Inspector
          checks={snapshot?.checks ?? []}
          handoffMarkdown={snapshot?.handoffMarkdown ?? ""}
          node={selectedNode}
          onSelectSeq={setSelectedSeq}
          visibleEvents={visibleEvents}
        />
      </section>

      <EventConsole events={visibleEvents} onSelectSeq={setSelectedSeq} />
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "ok" | "risk" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: WorkflowNode["status"] }) {
  return <span className={`status status-${status.toLowerCase()}`}>{status}</span>;
}

function Inspector({
  checks,
  handoffMarkdown,
  node,
  onSelectSeq,
  visibleEvents
}: {
  checks: PromiseCheck[];
  handoffMarkdown: string;
  node: WorkflowNode | null;
  onSelectSeq: (seq: number) => void;
  visibleEvents: TraceEvent[];
}) {
  if (!node) {
    return (
      <aside className="inspector">
        <h2>Inspector</h2>
        <p className="muted">No node selected.</p>
      </aside>
    );
  }
  return (
    <aside className="inspector">
      <h2>Inspector</h2>
      <div className="inspectHeader">
        <span>{node.type}</span>
        <StatusBadge status={node.status} />
      </div>
      <h3>{node.label}</h3>
      <dl>
        <dt>Created</dt>
        <dd>{node.createdAt}</dd>
        <dt>Updated</dt>
        <dd>{node.updatedAt}</dd>
        <dt>Events</dt>
        <dd>
          {node.eventIds.length === 0
            ? "none"
            : node.eventIds.map((eventId) => {
                const event = visibleEvents.find((candidate) => candidate.id === eventId);
                return event ? (
                  <button className="eventLink" key={eventId} onClick={() => onSelectSeq(event.seq)} type="button">
                    {eventId}
                  </button>
                ) : (
                  <span key={eventId}>{eventId}</span>
                );
              })}
        </dd>
      </dl>
      <section className="inspectSection">
        <h2>Evidence</h2>
        {visibleEvents
          .filter((event) => node.eventIds.includes(event.id))
          .map((event) => (
            <button className="eventRow compact" key={event.id} onClick={() => onSelectSeq(event.seq)} type="button">
              <span>{event.seq}</span>
              <strong>{event.kind}</strong>
              <em>{summarizeTraceEvent(event)}</em>
            </button>
          ))}
      </section>
      <pre>{JSON.stringify(node.data, null, 2)}</pre>
      <AuditPanel checks={checks} onSelectSeq={onSelectSeq} visibleEvents={visibleEvents} />
      <HandoffPanel markdown={handoffMarkdown} />
    </aside>
  );
}

function AuditPanel({
  checks,
  onSelectSeq,
  visibleEvents
}: {
  checks: PromiseCheck[];
  onSelectSeq: (seq: number) => void;
  visibleEvents: TraceEvent[];
}) {
  return (
    <section className="inspectSection">
      <h2>Audit</h2>
      {checks.length === 0 ? <p className="muted">No matching model promises yet.</p> : null}
      {checks.map((check, index) => (
        <article className={`check check-${check.status}`} key={`${check.claim}-${index}`}>
          <div>
            <strong>{check.status}</strong>
            <span>{check.severity}</span>
          </div>
          <p>{check.claim}</p>
          {check.evidenceEventIds.length > 0 ? (
            <div className="evidenceLinks">
              {check.evidenceEventIds.map((eventId) => {
                const event = visibleEvents.find((candidate) => candidate.id === eventId);
                return (
                  <button
                    disabled={!event}
                    key={eventId}
                    onClick={() => (event ? onSelectSeq(event.seq) : undefined)}
                    type="button"
                  >
                    {eventId}
                  </button>
                );
              })}
            </div>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function HandoffPanel({ markdown }: { markdown: string }) {
  return (
    <section className="inspectSection">
      <div className="sectionHeader">
        <h2>Handoff</h2>
        <button disabled={!markdown} onClick={() => downloadMarkdown(markdown)} type="button">
          Download
        </button>
      </div>
      <textarea readOnly value={markdown || "No handoff available yet."} />
    </section>
  );
}

function EventConsole({ events, onSelectSeq }: { events: TraceEvent[]; onSelectSeq: (seq: number) => void }) {
  return (
    <section className="eventConsole" aria-label="Event console">
      <h2>Natural Log</h2>
      <div>
        {events.slice(-14).map((event) => (
          <button className="eventRow" key={event.id} onClick={() => onSelectSeq(event.seq)} type="button">
            <span>{event.seq}</span>
            <strong>{event.kind}</strong>
            <em>{summarizeTraceEvent(event)}</em>
          </button>
        ))}
        {events.length === 0 ? <p className="muted">No replayed events yet.</p> : null}
      </div>
    </section>
  );
}

function downloadMarkdown(markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "agent-blackbox-handoff.md";
  anchor.click();
  URL.revokeObjectURL(url);
}

function toStreamUrl(baseUrl: string): string {
  const url = new URL("/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
