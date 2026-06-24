#!/usr/bin/env node
import { startClaudeCodeTailer } from "@agent-blackbox/claude-code-adapter";
import { evaluatePromiseChecks, generateHandoffMarkdown, materializeWorkflowGraph } from "@agent-blackbox/core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startDashboardServer } from "./dashboardServer.js";
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";
import { installClaudeCodeHooks, uninstallClaudeCodeHooks } from "./initClaudeHooks.js";
import { initOpenCodeProject, installGlobalRecorder, uninstallGlobalRecorder } from "./initOpenCode.js";
import { runOptimize, type OptimizeMode } from "./optimize.js";
import { buildReplaySummary, loadTraceEvents, startTraceDaemon } from "./server.js";
import type { SuggestionConfig, SuggestionMode } from "./suggestionProvider.js";

const args = process.argv.slice(2);
const cliDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(cliDir, "../../..");

// Resolve assets in a layout-agnostic way: the bundled npx package keeps them next
// to cli.js (dist/dashboard, dist/agent-blackbox.plugin.mjs); the dev tree keeps
// them at the repo paths. First existing wins.
const firstExisting = (paths: string[]): string | undefined => paths.find((p) => existsSync(p));
const dashboardDistDir =
  firstExisting([resolve(cliDir, "dashboard"), resolve(repoRoot, "apps/dashboard/dist")]) ??
  resolve(repoRoot, "apps/dashboard/dist");
// When present (npx build), the recorder is written self-contained from this bundle.
const pluginBundlePath = firstExisting([resolve(cliDir, "agent-blackbox.plugin.mjs")]);
// The Claude Code in-run actuator hook entry — bundled next to cli.js in the npx
// distribution, or the built dist when running from source.
const hookEntryPath = firstExisting([
  resolve(cliDir, "agent-blackbox-hook.mjs"),
  resolve(repoRoot, "packages/claude-code-adapter/dist/hook-entry.js")
]);

// Where global-mode recordings live — one store for every project's OpenCode
// sessions (XDG_DATA_HOME respected), since the global recorder isn't tied to a
// single project. Kept separate from any project's own .agent-blackbox/.
function globalDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? join(xdg, "agent-blackbox") : join(homedir(), ".local", "share", "agent-blackbox");
}

void main(args).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(AGENT_BLACKBOX_DAEMON_VERSION);
    return;
  }

  const command = argv[0] ?? "help";
  if (command === "daemon") {
    const projectDir = readFlag(argv, "--project") ?? process.cwd();
    const port = portArg(readFlag(argv, "--port"), 47831);
    const daemon = await startTraceDaemon({ projectDir, port });
    console.log(`Agent-Blackbox daemon listening on http://127.0.0.1:${daemon.port}`);
    console.log(`Trace file: ${daemon.eventsFile}`);
    return;
  }

  if (command === "up") {
    const projectFlag = readFlag(argv, "--project");
    // No --project → GLOBAL mode: record every OpenCode session (any folder, the
    // terminal, or the app), the way people actually use OpenCode. --project keeps
    // the old project-scoped behavior.
    const global = projectFlag === undefined;
    const port = portArg(readFlag(argv, "--port"), 47831);
    const uiPort = portArg(readFlag(argv, "--ui-port"), 5173);
    const daemonUrl = `http://127.0.0.1:${port}`;
    const suggest = readSuggestConfig(argv);

    let daemon: Awaited<ReturnType<typeof startTraceDaemon>>;
    if (global) {
      // Which agent host(s) to record. Daemon + dashboard are host-agnostic; only
      // the recorder install differs. `all` co-records every host into one daemon.
      const host = readHost(argv);
      const dataDir = globalDataDir();
      const eventsFile = join(dataDir, "events.ndjson");
      // Scope what the daemon records to the chosen host (unless `all`). This is the
      // root-cause guard for the "advice → score 100" bug: with `--host claude-code`,
      // a leftover global OpenCode recorder (and the suggestion model's own
      // `opencode run`) can no longer slip a trivial opencode run into the store and
      // hijack "latest". `all` keeps recording every host.
      daemon = await startTraceDaemon({
        projectDir: dataDir,
        port,
        eventsFile,
        suggest,
        ...(host === "all" ? {} : { recordHosts: [host] })
      });

      const recorders: string[] = [];
      if (host === "opencode" || host === "all") {
        if (!pluginBundlePath) {
          throw new Error(
            "The OpenCode recorder needs the self-contained bundle. Use the published npx package, or `npm run build:cli` then `node packages/cli/dist/cli.js up`.\n" +
              "(Claude Code needs no bundle — try: agent-blackbox up --host claude-code.)"
          );
        }
        const { pluginPath } = await installGlobalRecorder({ daemonUrl, pluginBundlePath });
        recorders.push(`OpenCode recorder installed → ${pluginPath}`);
      }
      if (host === "claude-code" || host === "all") {
        // No install needed to RECORD — the daemon tails the JSONL transcripts the
        // CLI already writes, streaming events in-process via daemon.ingest.
        const tailer = await startClaudeCodeTailer({ write: (event) => daemon.ingest(event) });
        recorders.push(`Claude Code transcripts tailed ← ${tailer.projectsDir} (no install)`);
        // --optimize additionally installs the opt-in in-run actuator (hooks).
        if (argv.includes("--optimize")) {
          if (hookEntryPath) {
            const { settingsPath } = await installClaudeCodeHooks({ hookEntryPath });
            recorders.push(`Claude Code in-run actuator installed → ${settingsPath} (read-dedup + working-set)`);
          } else {
            recorders.push("Claude Code actuator needs the built hook — run `npm run build` first (recording only for now).");
          }
        }
      }
      if (host === "codex") {
        recorders.push("Codex recorder isn't built yet (see local-planning/). Use --host opencode|claude-code|all.");
      }

      const ui = await startDashboardServer({ distDir: dashboardDistDir, port: uiPort, daemonUrl });
      const dashboardUrl = `http://127.0.0.1:${ui.port}`;
      for (const line of recorders) console.log(`✓ ${line}`);
      console.log(`✓ Agent-Blackbox is up (host: ${host})`);
      console.log(`  Dashboard:  ${dashboardUrl}`);
      console.log(`  Daemon API: ${daemonUrl}  (trace: ${daemon.eventsFile})`);
      console.log(`  Suggestions: ${suggest.mode}${suggest.model ? ` (${suggest.model})` : ""}`);
      console.log("");
      if (!argv.includes("--no-open")) openInBrowser(dashboardUrl);
      if (host === "claude-code" || host === "all") {
        console.log("Now use Claude Code however you already do — the map fills in live as it writes transcripts.");
      }
      if (host === "opencode" || host === "all") {
        console.log("Now use OpenCode however you already do (terminal or the desktop app) — the map fills in live.");
      }
      console.log("");
      console.log("Stop recording any time with:  agent-blackbox uninstall");
      console.log("Press Ctrl+C to stop the daemon + dashboard.");
      return;
    }

    const projectDir = resolve(projectFlag);
    const adapterPackage = readFlag(argv, "--adapter-package") ?? `file:${resolve(repoRoot, "packages/opencode-adapter")}`;
    try {
      const result = await initOpenCodeProject({
        projectDir,
        daemonUrl,
        adapterPackage,
        force: false,
        optimize: argv.includes("--optimize"),
        ...(pluginBundlePath ? { pluginBundlePath } : {})
      });
      console.log(`✓ OpenCode recorder plugin installed: ${result.pluginPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        console.log("✓ OpenCode recorder plugin already present");
      } else {
        throw error;
      }
    }

    daemon = await startTraceDaemon({ projectDir, port, suggest });
    const ui = await startDashboardServer({ distDir: dashboardDistDir, port: uiPort, daemonUrl });

    const dashboardUrl = `http://127.0.0.1:${ui.port}`;
    console.log("");
    console.log(`✓ Agent-Blackbox is up for ${projectDir}`);
    console.log(`  Dashboard:  ${dashboardUrl}`);
    console.log(`  Daemon API: ${daemonUrl}  (trace: ${daemon.eventsFile})`);
    console.log(`  Suggestions: ${suggest.mode}${suggest.model ? ` (${suggest.model})` : ""}`);
    console.log("");
    if (!argv.includes("--no-open")) openInBrowser(dashboardUrl);
    console.log("Now run your agent in that project, e.g.:");
    console.log(`  opencode    # in ${projectDir} (the project-local recorder streams here)`);
    console.log("");
    console.log("Press Ctrl+C to stop.");
    return;
  }

  if (command === "install") {
    const port = portArg(readFlag(argv, "--port"), 47831);
    const daemonUrl = `http://127.0.0.1:${port}`;
    if (!pluginBundlePath) {
      throw new Error("Global install needs the self-contained recorder bundle. Use the published npx package, or `npm run build:cli` first.");
    }
    const { pluginPath } = await installGlobalRecorder({ daemonUrl, pluginBundlePath });
    console.log(`✓ Global OpenCode recorder installed: ${pluginPath}`);
    console.log(`  Every OpenCode session (any folder, terminal, or the app) now streams to ${daemonUrl}.`);
    console.log(`  Start the dashboard with:  agent-blackbox up`);
    console.log(`  Remove with:               agent-blackbox uninstall`);
    return;
  }

  if (command === "uninstall") {
    const { pluginPath, removed } = await uninstallGlobalRecorder();
    console.log(removed ? `✓ Removed global OpenCode recorder: ${pluginPath}` : `Nothing to remove — ${pluginPath} is not present.`);
    const hooks = await uninstallClaudeCodeHooks();
    if (hooks.removed) console.log(`✓ Removed Claude Code actuator hooks: ${hooks.settingsPath}`);
    return;
  }

  if (command === "install-hooks") {
    if (!hookEntryPath) {
      throw new Error("Built hook not found. Run `npm run build` first, or use the published npx package.");
    }
    const { settingsPath } = await installClaudeCodeHooks({ hookEntryPath });
    console.log(`✓ Claude Code in-run actuator installed: ${settingsPath}`);
    console.log("  New sessions get PreToolUse read-dedup (skip re-reading unchanged files) + a UserPromptSubmit working-set reminder.");
    console.log("  Remove with: agent-blackbox uninstall-hooks");
    return;
  }

  if (command === "uninstall-hooks") {
    const { settingsPath, removed } = await uninstallClaudeCodeHooks();
    console.log(removed ? `✓ Removed Claude Code actuator hooks: ${settingsPath}` : `Nothing to remove — no Agent-Blackbox hooks in ${settingsPath}.`);
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
      optimize: argv.includes("--optimize"),
      ...(pluginBundlePath ? { pluginBundlePath } : {})
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
  console.log("  agent-blackbox up                       # GLOBAL: record every OpenCode session (any folder / the app) + daemon + dashboard");
  console.log("  agent-blackbox up --host claude-code     # record Claude Code instead — no install, tails transcripts (also: opencode | codex | all)");
  console.log("  agent-blackbox up --project <dir>        # scope the recorder to one project instead");
  console.log("       [--port <port>] [--ui-port <port>] [--suggest auto|free|off|ollama|opencode|openai-compat] [--suggest-model <id>] [--optimize] [--no-open]");
  console.log("       [--optimize]  with --host claude-code: also install the in-run actuator (read-dedup + working-set hooks)");
  console.log("  agent-blackbox install [--port <port>]   # install the global recorder only (no daemon)");
  console.log("  agent-blackbox install-hooks             # install the Claude Code in-run actuator hooks (opt-in)");
  console.log("  agent-blackbox uninstall-hooks           # remove the Claude Code actuator hooks");
  console.log("  agent-blackbox uninstall                 # remove the global recorder (+ Claude Code hooks)");
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
    // A missing opener binary (xdg-open/open/cmd) surfaces asynchronously as an
    // 'error' event, not a sync throw; without a listener the EventEmitter would
    // rethrow it as an uncaught exception and tear down the daemon we just started.
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
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

// readFlag returns the next token unconditionally, so a flag that is last or
// followed by another flag yields a non-numeric value and Number(...) → NaN. Fall
// back to the default for a missing OR malformed value instead of binding NaN.
function portArg(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

function readHost(argv: string[]): "opencode" | "claude-code" | "codex" | "all" {
  const allowed = ["opencode", "claude-code", "codex", "all"] as const;
  const raw = readFlag(argv, "--host") ?? process.env.AGENT_BLACKBOX_HOST ?? "opencode";
  return (allowed as readonly string[]).includes(raw) ? (raw as (typeof allowed)[number]) : "opencode";
}

function readSuggestConfig(argv: string[]): SuggestionConfig {
  const modes: SuggestionMode[] = ["auto", "off", "free", "ollama", "opencode", "openai-compat"];
  const raw = readFlag(argv, "--suggest") ?? process.env.AGENT_BLACKBOX_SUGGEST ?? "auto";
  const mode = (modes as string[]).includes(raw) ? (raw as SuggestionMode) : "auto";
  const model = readFlag(argv, "--suggest-model") ?? process.env.AGENT_BLACKBOX_SUGGEST_MODEL;
  const baseUrl = readFlag(argv, "--suggest-base-url") ?? process.env.AGENT_BLACKBOX_SUGGEST_BASE_URL;
  return { mode, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) };
}
