import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle the monorepo into a single self-contained, npx-runnable package:
//   dist/cli.js                  — the daemon CLI with core/storage/etc. inlined
//   dist/agent-blackbox.plugin.mjs — the recorder, inlined (init writes it into a project)
//   dist/dashboard/              — the prebuilt operator console
// Run AFTER `npm run build` (needs the tsc output in apps/*/dist and packages/*/dist).
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(here, "dist");

const cliEntry = resolve(repo, "apps/daemon/dist/cli.js");
const pluginEntry = resolve(repo, "packages/opencode-adapter/dist/plugin-entry.js");
const dashboard = resolve(repo, "apps/dashboard/dist");
for (const [label, p] of [["daemon", cliEntry], ["adapter", pluginEntry], ["dashboard", dashboard]]) {
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

console.log("✓ built @taewoopark/agent-blackbox → dist/ (cli.js, agent-blackbox.plugin.mjs, dashboard/)");
