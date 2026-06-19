import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the product version: the package.json shipped beside
// this module. Walk up from the module dir so `--version` always matches the
// *installed* package — packages/cli/package.json in the published npx bundle
// (dist/cli.js → ../package.json), apps/daemon/package.json in a source run —
// instead of a constant that silently drifts from the release tag and npm.
function resolvePackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    } catch {
      // no package.json here — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const AGENT_BLACKBOX_DAEMON_VERSION = resolvePackageVersion();

export function describeDaemon(): string {
  return "Agent-Blackbox daemon: local ingest, replay, and dashboard bridge.";
}

export type { RunningTraceDaemon, TraceDaemonOptions } from "./server.js";
export { buildReplaySummary, loadTraceEvents, startTraceDaemon } from "./server.js";
export type { InitOpenCodeOptions, InitOpenCodeResult } from "./initOpenCode.js";
export { initOpenCodeProject, renderOpenCodePlugin } from "./initOpenCode.js";
