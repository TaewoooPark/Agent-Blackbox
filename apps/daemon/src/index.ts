export const AGENT_BLACKBOX_DAEMON_VERSION = "0.1.0";

export function describeDaemon(): string {
  return "Agent-Blackbox daemon: local ingest, replay, and dashboard bridge.";
}

export type { RunningTraceDaemon, TraceDaemonOptions } from "./server.js";
export { buildReplaySummary, loadTraceEvents, startTraceDaemon } from "./server.js";
export type { InitOpenCodeOptions, InitOpenCodeResult } from "./initOpenCode.js";
export { initOpenCodeProject, renderOpenCodePlugin } from "./initOpenCode.js";
