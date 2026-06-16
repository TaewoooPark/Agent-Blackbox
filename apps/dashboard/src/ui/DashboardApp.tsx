import type { WorkflowGraph, WorkflowNode } from "@agent-blackbox/core";
import { useEffect, useMemo, useState } from "react";
import { layoutGraphNodes, summarizeGraph } from "../graphLayout.js";

const daemonUrl = import.meta.env.VITE_AGENT_BLACKBOX_DAEMON_URL ?? "http://127.0.0.1:47831";

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { message: string };
};

export function DashboardApp() {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadGraph() {
      try {
        const response = await fetch(`${daemonUrl}/graph`);
        const payload = (await response.json()) as ApiResponse<WorkflowGraph>;
        if (!active) return;
        if (!payload.ok || !payload.data) {
          setError(payload.error?.message ?? "Daemon returned no graph");
          return;
        }
        setGraph(payload.data);
        setError(null);
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    }

    void loadGraph();
    const interval = window.setInterval(() => {
      void loadGraph();
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const summary = useMemo(() => (graph ? summarizeGraph(graph) : null), [graph]);
  const positionedNodes = useMemo(() => (graph ? layoutGraphNodes(graph) : []), [graph]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId) ?? graph?.nodes[0] ?? null;
  const agentNodes = graph?.nodes.filter((node) => node.type === "AGENT") ?? [];

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
            <div className="ticks">
              {(graph?.appliedEventIds ?? []).slice(-80).map((eventId, index) => (
                <span key={`${eventId}-${index}`} title={eventId} />
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

        <Inspector node={selectedNode} />
      </section>
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

function Inspector({ node }: { node: WorkflowNode | null }) {
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
        <dd>{node.eventIds.join(", ") || "none"}</dd>
      </dl>
      <pre>{JSON.stringify(node.data, null, 2)}</pre>
    </aside>
  );
}

