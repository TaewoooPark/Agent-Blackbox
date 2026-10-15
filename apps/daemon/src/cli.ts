#!/usr/bin/env node
import { startClaudeCodeTailer } from "@agent-blackbox/claude-code-adapter";
import { startCodexTailer } from "@agent-blackbox/codex-adapter";
import { startGjcTailer } from "@agent-blackbox/gjc-adapter";
import { startMotifcodeTailer } from "@agent-blackbox/motifcode-adapter";
import { evaluatePromiseChecks, generateHandoffMarkdown, materializeWorkflowGraph } from "@agent-blackbox/core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startDashboardServer } from "./dashboardServer.js";
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";
import { installClaudeCodeHooks, uninstallClaudeCodeHooks } from "./initClaudeHooks.js";
import { installCodexHooks, uninstallCodexHooks } from "./initCodexHooks.js";
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
const codexHookEntryPath = firstExisting([
  resolve(cliDir, "agent-blackbox-codex-hook.mjs"),
  resolve(repoRoot, "packages/codex-adapter/dist/hook-entry.js")
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
    // `up` brings several long-lived pieces online in sequence (daemon → recorders
    // → dashboard). When a later one fails — a busy --ui-port is the common case —
    // the earlier ones stay listening and keep the event loop alive, so the CLI used
    // to print the error and then hang forever while still holding the daemon port
    // (which made the obvious retry fail too). Register every started piece and
    // unwind it on failure: `up` either comes up whole or exits cleanly.
    const started: Teardown[] = [];
    try {
      await runUp(argv, started);
    } catch (error) {
      await unwind(started);
      throw error;
    }
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
    const codexHooks = await uninstallCodexHooks();
    if (codexHooks.removed) console.log(`✓ Removed Codex actuator hooks: ${codexHooks.hooksPath}`);
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

  if (command === "install-codex-hooks") {
    if (!codexHookEntryPath) {
      throw new Error("Built Codex hook not found. Run `npm run build` first, or use the published npx package.");
    }
    const { hooksPath } = await installCodexHooks({ hookEntryPath: codexHookEntryPath });
    console.log(`✓ Codex in-run actuator installed: ${hooksPath}`);
    console.log("  Review/trust the hook once with /hooks in Codex. Remove with: agent-blackbox uninstall-codex-hooks");
    return;
  }

  if (command === "uninstall-codex-hooks") {
    const { hooksPath, removed } = await uninstallCodexHooks();
    console.log(removed ? `✓ Removed Codex actuator hooks: ${hooksPath}` : `Nothing to remove — no Agent-Blackbox hooks in ${hooksPath}.`);
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
    console.log(generateHandoffMarkdown(materializeWorkflowGraph(events), evaluatePromiseChecks(events), events));
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

// A long-lived piece started by `up` (daemon, recorder tailer, dashboard), paired
// with the call that shuts it down again.
type Teardown = () => void | Promise<void>;

// Unwind in reverse start order, best-effort: we are already failing, so a stubborn
// close must not mask the original error.
async function unwind(started: Teardown[]): Promise<void> {
  for (const stop of started.reverse()) {
    try {
      await stop();
    } catch {
      // ignore — nothing useful to do while tearing a failed startup down
    }
  }
}

async function runUp(argv: string[], started: Teardown[]): Promise<void> {
  const projectFlag = readFlag(argv, "--project");
  const projectDir = resolve(projectFlag ?? process.cwd());
  // --project selects the trace store, OpenCode plugin location, and Motifcode
  // workspace. Other transcript tailers keep their existing global locations.
  const global = projectFlag === undefined;
  const host = readHost(argv);
  const port = portArg(readFlag(argv, "--port"), 47831);
  const uiPort = portArg(readFlag(argv, "--ui-port"), 5173);
  const daemonUrl = `http://127.0.0.1:${port}`;
  const suggest = readSuggestConfig(argv);
  const backfillDays = readBackfillDays(argv);

  // Which agent host(s) to record. Daemon + dashboard are host-agnostic; only
  // the recorder install differs. `all` co-records every host into one daemon.
  const dataDir = global ? globalDataDir() : projectDir;
  const eventsFile = global ? join(dataDir, "events.ndjson") : join(dataDir, ".agent-blackbox", "events.ndjson");
  // Scope what the daemon records to the chosen host (unless `all`). This is the
  // root-cause guard for the "advice → score 100" bug: with `--host claude-code`,
  // a leftover global OpenCode recorder (and the suggestion model's own
  // `opencode run`) can no longer slip a trivial opencode run into the store and
  // hijack "latest". `all` keeps recording every host.
  const daemon = await startTraceDaemon({
    projectDir: dataDir,
    port,
    eventsFile,
    suggest,
    ...(host === "all" ? {} : { recordHosts: [host] })
  });
  started.push(() => daemon.close());

  const recorders: string[] = [];
  if (host === "opencode" || host === "all") {
    if (global) {
      if (!pluginBundlePath) {
        throw new Error(
          "The OpenCode recorder needs the self-contained bundle. Use the published npx package, or `npm run build:cli` then `node packages/cli/dist/cli.js up`.\n" +
            "(Claude Code needs no bundle — try: agent-blackbox up --host claude-code.)"
        );
      }
      const { pluginPath } = await installGlobalRecorder({ daemonUrl, pluginBundlePath });
      recorders.push(`OpenCode recorder installed → ${pluginPath}`);
    } else {
      recorders.push(await installProjectRecorder(projectDir, daemonUrl, argv));
    }
  }
  if (host === "claude-code" || host === "all") {
    // No install needed to RECORD — the daemon tails the JSONL transcripts the
    // CLI already writes, streaming events in-process via daemon.ingest.
    const tailer = await startClaudeCodeTailer({ write: (event) => daemon.ingest(event) }, { backfillDays });
    started.push(tailer.stop);
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
  if (host === "gjc" || host === "all") {
    const tailer = await startGjcTailer({ write: (event) => daemon.ingest(event) }, { backfillDays });
    started.push(tailer.stop);
    recorders.push(`Gajae-Code sessions tailed ← ${tailer.sessionsDir} (no install)`);
  }
  if (host === "codex" || host === "all") {
    const tailer = await startCodexTailer({ write: (event) => daemon.ingest(event) }, { backfillDays });
    started.push(tailer.stop);
    recorders.push(`Codex sessions tailed ← ${tailer.sessionsDir} (no install)`);
    if (argv.includes("--optimize")) {
      if (codexHookEntryPath) {
        const { hooksPath } = await installCodexHooks({ hookEntryPath: codexHookEntryPath });
        recorders.push(`Codex in-run actuator installed → ${hooksPath} (read-dedup + working-set)`);
      } else {
        recorders.push("Codex actuator needs the built hook — run `npm run build` first (recording only for now).");
      }
    }
  }
  if (host === "motifcode" || host === "all") {
    const sessionsDir = readFlag(argv, "--motifcode-sessions-dir");
    const tailer = await startMotifcodeTailer({ write: (event) => daemon.ingest(event) }, {
      backfillDays,
      projectDir,
      ...(sessionsDir ? { sessionsDir: resolve(sessionsDir) } : {})
    });
    started.push(tailer.stop);
    recorders.push(`Motifcode sessions tailed ← ${tailer.sessionsDir} (no install)`);
  }

  const ui = await startDashboardServer({ distDir: dashboardDistDir, port: uiPort, daemonUrl });
  started.push(() => ui.close());
  const dashboardUrl = `http://127.0.0.1:${ui.port}`;
  for (const line of recorders) console.log(`✓ ${line}`);
  console.log(`✓ Agent-Blackbox is up (host: ${host})${global ? "" : ` for ${projectDir}`}`);
  console.log(`  Dashboard:  ${dashboardUrl}`);
  console.log(`  Daemon API: ${daemonUrl}  (trace: ${daemon.eventsFile})`);
  console.log(`  Suggestions: ${suggest.mode}${suggest.model ? ` (${suggest.model})` : ""}`);
  console.log("");
  if (!argv.includes("--no-open")) openInBrowser(dashboardUrl);
  if (host === "claude-code" || host === "all") {
    console.log("Now use Claude Code however you already do — the map fills in live as it writes transcripts.");
  }
  if (host === "gjc" || host === "all") {
    console.log("Now use Gajae-Code however you already do — the map fills in live as it writes sessions.");
  }
  if (host === "codex" || host === "all") {
    console.log("Now use Codex however you already do (CLI or desktop app) — the map fills in live as it writes sessions.");
    if (argv.includes("--optimize")) console.log("For the Codex actuator, review/trust the installed commands once with /hooks.");
  }
  if (host === "opencode" || host === "all") {
    console.log(global
      ? "Now use OpenCode however you already do (terminal or the desktop app) — the map fills in live."
      : `Now run opencode in ${projectDir} — the project-local recorder streams here.`);
  }
  if (host === "motifcode" || host === "all") {
    console.log("Now use Motifcode — the map fills in as it saves sessions; recording resumes when its model connection recovers.");
  }
  console.log("");
  if (global && (host === "opencode" || host === "all")) {
    console.log("Remove the global recorder any time with:  agent-blackbox uninstall");
  }
  console.log("Press Ctrl+C to stop the daemon + dashboard.");
}

async function installProjectRecorder(projectDir: string, daemonUrl: string, argv: string[]): Promise<string> {
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
    return `OpenCode recorder plugin installed: ${result.pluginPath}`;
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) {
      return "OpenCode recorder plugin already present";
    }
    throw error;
  }
}

function printHelp(): void {
  console.log(describeDaemon());
  console.log("");
  console.log("Usage:");
  console.log("  agent-blackbox up                       # GLOBAL: record every OpenCode session (any folder / the app) + daemon + dashboard");
  console.log("  agent-blackbox up --host claude-code     # record Claude Code instead — no install, tails transcripts (also: codex | opencode | gjc | motifcode | all)");
  console.log("  agent-blackbox up --project <dir>        # project trace store + OpenCode plugin / Motifcode source directory");
  console.log("  agent-blackbox up --host motifcode      # tail <cwd>/.motif/sessions; no model connection needed to start");
  console.log("       [--motifcode-sessions-dir <dir>]  override the Motifcode session directory (also with --host all)");
  console.log("       [--port <port>] [--ui-port <port>] [--suggest auto|free|off|ollama|opencode|openai-compat] [--suggest-model <id>] [--optimize] [--no-open]");
  console.log("       [--optimize]  with --host claude-code or codex: also install the in-run actuator (read-dedup + working-set hooks)");
  console.log("       [--backfill-days <n>]  re-read sessions written in the last <n> days from the top (default 0 = from now on)");
  console.log("  agent-blackbox install [--port <port>]   # install the global recorder only (no daemon)");
  console.log("  agent-blackbox install-hooks             # install the Claude Code in-run actuator hooks (opt-in)");
  console.log("  agent-blackbox uninstall-hooks           # remove the Claude Code actuator hooks");
  console.log("  agent-blackbox install-codex-hooks       # install the Codex in-run actuator hooks (opt-in; trust once with /hooks)");
  console.log("  agent-blackbox uninstall-codex-hooks     # remove the Codex actuator hooks");
  console.log("  agent-blackbox uninstall                 # remove the global recorder (+ Claude Code/Codex hooks)");
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

// A flag's value is the next token — but only if that token isn't itself a flag.
// Returning it unconditionally turned a typo into a side effect: `up --project
// --port 5000` bound projectDir to the literal string "--port" and scaffolded a
// directory named that. Missing values now fail loudly instead of being guessed.
function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} needs a value, e.g. ${flag} <value>.`);
  }
  return value;
}

// A present-but-malformed value (`--port abc`) still falls back to the default
// rather than binding NaN; a missing value is rejected by readFlag above.
function portArg(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : fallback;
}

function readHost(argv: string[]): "opencode" | "claude-code" | "gjc" | "codex" | "motifcode" | "all" {
  const allowed = ["opencode", "claude-code", "gjc", "codex", "motifcode", "all"] as const;
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

// How many days of already-written sessions to re-read from the top on `up`.
// The tailers all support backfill but default to 0 (record from now on), which
// leaves the dashboard empty until a fresh session is written. This exposes it
// as `--backfill-days N` / AGENT_BLACKBOX_BACKFILL_DAYS. Malformed/negative → 0.
function readBackfillDays(argv: string[]): number {
  const raw = readFlag(argv, "--backfill-days") ?? process.env.AGENT_BLACKBOX_BACKFILL_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
