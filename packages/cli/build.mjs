import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle the monorepo into a single self-contained, npx-runnable package:
//   dist/cli.js                  — the daemon CLI with core/storage/etc. inlined
//   dist/agent-blackbox.plugin.mjs — the OpenCode recorder, inlined
//   dist/agent-blackbox-hook.mjs — the Claude Code optimizer hook, inlined
//   dist/agent-blackbox-codex-hook.mjs — the Codex optimizer hook, inlined
//   dist/dashboard/              — the prebuilt operator console
// Run AFTER `npm run build` (needs the tsc output in apps/*/dist and packages/*/dist).
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(here, "dist");

const cliEntry = resolve(repo, "apps/daemon/dist/cli.js");
const pluginEntry = resolve(repo, "packages/opencode-adapter/dist/plugin-entry.js");
const claudeHookEntry = resolve(repo, "packages/claude-code-adapter/dist/hook-entry.js");
const codexHookEntry = resolve(repo, "packages/codex-adapter/dist/hook-entry.js");
const dashboard = resolve(repo, "apps/dashboard/dist");
for (const [label, p] of [["daemon", cliEntry], ["adapter", pluginEntry], ["Claude hook", claudeHookEntry], ["Codex hook", codexHookEntry], ["dashboard", dashboard]]) {
  if (!existsSync(p)) throw new Error(`missing ${label} build (${p}) — run \`npm run build\` at the repo root first`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The CLI — bundle everything except node builtins and ws (kept as a real dep).
await build({
  entryPoints: [cliEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(out, "cli.js"),
  external: ["ws"],
  // esbuild preserves the entry file's shebang; adding our own would duplicate it
  // and a second shebang breaks ESM loading.
  logLevel: "warning"
});
chmodSync(resolve(out, "cli.js"), 0o755);

// 2. The recorder plugin — fully self-contained (only AgentBlackbox is exported).
await build({
  entryPoints: [pluginEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: resolve(out, "agent-blackbox.plugin.mjs"),
  logLevel: "warning"
});

// 3. The dashboard static bundle.
cpSync(dashboard, resolve(out, "dashboard"), { recursive: true });

// 4. Optimizer hook executables. They are spawned by Claude Code / Codex and
// must be self-contained in the published package.
for (const [entry, outfile] of [
  [claudeHookEntry, "agent-blackbox-hook.mjs"],
  [codexHookEntry, "agent-blackbox-codex-hook.mjs"]
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: resolve(out, outfile),
    logLevel: "warning"
  });
  chmodSync(resolve(out, outfile), 0o755);
}

console.log("✓ built @taewooopark/agent-blackbox → dist/ (CLI, recorders/hooks, dashboard/)");
