#!/usr/bin/env node
import { evaluatePromiseChecks, generateHandoffMarkdown, materializeWorkflowGraph } from "@agent-blackbox/core";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startDashboardServer } from "./dashboardServer.js";
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";
import { initOpenCodeProject } from "./initOpenCode.js";
import { runOptimize, type OptimizeMode } from "./optimize.js";
import { buildReplaySummary, loadTraceEvents, startTraceDaemon } from "./server.js";
import type { SuggestionConfig, SuggestionMode } from "./suggestionProvider.js";

const args = process.argv.slice(2);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

void main(args);

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(AGENT_BLACKBOX_DAEMON_VERSION);
    return;
  }

  const command = argv[0] ?? "help";
  if (command === "daemon") {
    const projectDir = readFlag(argv, "--project") ?? process.cwd();
    const port = Number(readFlag(argv, "--port") ?? "47831");
    const daemon = await startTraceDaemon({ projectDir, port });
    console.log(`Agent-Blackbox daemon listening on http://127.0.0.1:${daemon.port}`);
    console.log(`Trace file: ${daemon.eventsFile}`);
    return;
  }

  if (command === "up") {
    const projectDir = resolve(readFlag(argv, "--project") ?? process.cwd());
    const port = Number(readFlag(argv, "--port") ?? "47831");
    const uiPort = Number(readFlag(argv, "--ui-port") ?? "5173");
    const daemonUrl = `http://127.0.0.1:${port}`;
    const adapterPackage = readFlag(argv, "--adapter-package") ?? `file:${resolve(repoRoot, "packages/opencode-adapter")}`;
    const suggest = readSuggestConfig(argv);

    try {
      const result = await initOpenCodeProject({ projectDir, daemonUrl, adapterPackage, force: false, optimize: argv.includes("--optimize") });
      console.log(`✓ OpenCode recorder plugin installed: ${result.pluginPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        console.log("✓ OpenCode recorder plugin already present");
      } else {
        throw error;
      }
    }

    const daemon = await startTraceDaemon({ projectDir, port, suggest });
    const distDir = resolve(repoRoot, "apps/dashboard/dist");
    const ui = await startDashboardServer({ distDir, port: uiPort, daemonUrl });

    const dashboardUrl = `http://127.0.0.1:${ui.port}`;
    console.log("");
    console.log(`✓ Agent-Blackbox is up for ${projectDir}`);
    console.log(`  Dashboard:  ${dashboardUrl}`);
    console.log(`  Daemon API: ${daemonUrl}  (trace: ${daemon.eventsFile})`);
    console.log(`  Suggestions: ${suggest.mode}${suggest.model ? ` (${suggest.model})` : ""}`);
    console.log("");
    if (!argv.includes("--no-open")) openInBrowser(dashboardUrl);
    console.log("Now run your agent in that project, e.g.:");
    console.log(`  AGENT_BLACKBOX_DAEMON_URL=${daemonUrl} opencode run --dir ${projectDir} "Read the code, run tests, summarize."`);
    console.log("");
    console.log("Press Ctrl+C to stop.");
    return;
  }

  if (command === "replay") {
    const eventsFile = argv[1];
    if (!eventsFile) {
      throw new Error("Usage: agent-blackbox replay <events.ndjson>");
    }
    console.log(JSON.stringify(await buildReplaySummary(eventsFile), null, 2));
    return;
  }

  if (command === "handoff") {
    const eventsFile = argv[1];
    if (!eventsFile) {
      throw new Error("Usage: agent-blackbox handoff <events.ndjson>");
    }
    const events = await loadTraceEvents(eventsFile);
    console.log(generateHandoffMarkdown(materializeWorkflowGraph(events), evaluatePromiseChecks(events)));
    return;
  }

  if (command === "init-opencode") {
    const projectDir = readFlag(argv, "--project") ?? process.cwd();
    const daemonUrl = readFlag(argv, "--daemon-url");
    const adapterPackage = readFlag(argv, "--adapter-package");
    const result = await initOpenCodeProject({
      projectDir,
      ...(daemonUrl ? { daemonUrl } : {}),
      ...(adapterPackage ? { adapterPackage } : {}),
      force: argv.includes("--force"),
      optimize: argv.includes("--optimize")
    });
    console.log(`OpenCode plugin written: ${result.pluginPath}`);
    console.log(`OpenCode package config written: ${result.packageJsonPath}`);
    return;
  }

  if (command === "optimize") {
    const projectDir = resolve(readFlag(argv, "--project") ?? process.cwd());
    const mode: OptimizeMode = argv.includes("--apply")
      ? "apply"
      : argv.includes("--check")
        ? "check"
        : argv.includes("--revert")
          ? "revert"
          : "preview";
    const result = await runOptimize({ projectDir, mode });
    console.log(`Agent-Blackbox optimize (${result.mode}) — ${result.agentsMdPath}`);
    if (result.score !== null) console.log(`  Latest run score: ${result.score}${result.baselineScore !== null ? ` (baseline ${result.baselineScore})` : ""}`);
    if (result.reclaimableTokens && result.reclaimableTokens > 0) console.log(`  Reclaimable waste this run: ~${result.reclaimableTokens} tokens`);
    console.log(`  ${result.action}`);
    if (result.block) {
      console.log("");
      console.log(result.block);
    }
    if (mode === "check") console.log("\nNote: scores compare different runs, so this is a heuristic — auto-revert only fires on a clear drop.");
    return;
  }

  printHelp();
}

function printHelp(): void {
  console.log(describeDaemon());
  console.log("");
  console.log("Usage:");
  console.log("  agent-blackbox up [--project <dir>] [--port <port>] [--ui-port <port>]   # plugin + daemon + dashboard, one command");
  console.log("       [--suggest auto|free|off|ollama|opencode|openai-compat] [--suggest-model <id>] [--suggest-base-url <url>] [--optimize] [--no-open]");
  console.log("  agent-blackbox daemon [--project <dir>] [--port <port>]");
  console.log("  agent-blackbox init-opencode [--project <dir>] [--daemon-url <url>] [--adapter-package <specifier>] [--force] [--optimize]");
  console.log("  agent-blackbox optimize [--project <dir>] [--apply | --check | --revert]   # write/measure/rollback AGENTS.md efficiency memory");
  console.log("  agent-blackbox handoff <events.ndjson>");
  console.log("  agent-blackbox replay <events.ndjson>");
  console.log("  agent-blackbox --version");
}

// Pop the dashboard open in the default browser so "up" is one step, not two.
// Best-effort and cross-platform; `--no-open` skips it.
function openInBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser/opener available (headless, CI) — the URL is already printed above.
  }
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}

function readSuggestConfig(argv: string[]): SuggestionConfig {
  const modes: SuggestionMode[] = ["auto", "off", "free", "ollama", "opencode", "openai-compat"];
  const raw = readFlag(argv, "--suggest") ?? process.env.AGENT_BLACKBOX_SUGGEST ?? "auto";
  const mode = (modes as string[]).includes(raw) ? (raw as SuggestionMode) : "auto";
  const model = readFlag(argv, "--suggest-model") ?? process.env.AGENT_BLACKBOX_SUGGEST_MODEL;
  const baseUrl = readFlag(argv, "--suggest-base-url") ?? process.env.AGENT_BLACKBOX_SUGGEST_BASE_URL;
  return { mode, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) };
}
