#!/usr/bin/env node
import { evaluatePromiseChecks, generateHandoffMarkdown, materializeWorkflowGraph } from "@agent-blackbox/core";
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";
import { initOpenCodeProject } from "./initOpenCode.js";
import { buildReplaySummary, loadTraceEvents, startTraceDaemon } from "./server.js";

const args = process.argv.slice(2);

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
      force: argv.includes("--force")
    });
    console.log(`OpenCode plugin written: ${result.pluginPath}`);
    console.log(`OpenCode package config written: ${result.packageJsonPath}`);
    return;
  }

  printHelp();
}

function printHelp(): void {
  console.log(describeDaemon());
  console.log("");
  console.log("Usage:");
  console.log("  agent-blackbox daemon [--project <dir>] [--port <port>]");
  console.log("  agent-blackbox init-opencode [--project <dir>] [--daemon-url <url>] [--adapter-package <specifier>] [--force]");
  console.log("  agent-blackbox handoff <events.ndjson>");
  console.log("  agent-blackbox replay <events.ndjson>");
  console.log("  agent-blackbox --version");
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}
