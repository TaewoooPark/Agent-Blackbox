import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type InitOpenCodeOptions = {
  projectDir: string;
  daemonUrl?: string;
  adapterPackage?: string;
  force?: boolean;
  optimize?: boolean;
  // When set (the npx/bundled distribution), the recorder is written as a single
  // self-contained plugin file with the adapter inlined — no `file:` dep, no
  // npm install in the user's project.
  pluginBundlePath?: string;
};

export type InitOpenCodeResult = {
  pluginPath: string;
  packageJsonPath: string;
  adapterPackage: string;
  adapterImport: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
};

const defaultAdapterPackage = "@agent-blackbox/opencode-adapter";
const defaultDaemonUrl = "http://127.0.0.1:47831";

// OpenCode auto-loads every file in ~/.config/opencode/plugins/ for ALL sessions
// (any folder, the terminal, or the desktop app) — not just the project you
// happened to scaffold. Dropping the self-contained recorder here is what
// connects Agent-Blackbox to how people actually use OpenCode.
// https://opencode.ai/docs/plugins/  (XDG_CONFIG_HOME respected.)
export function globalOpenCodeDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? join(xdg, "opencode") : join(homedir(), ".config", "opencode");
}

export function globalRecorderPath(): string {
  return join(globalOpenCodeDir(), "plugins", "agent-blackbox.js");
}

/**
 * Install the recorder into OpenCode's GLOBAL plugin directory so every session
 * streams to the daemon — no per-project scaffolding, no `--dir`, works with the
 * OpenCode app too. Requires the self-contained bundle (the npx distribution
 * ships it; from source run `npm run build:cli` first). Idempotent: re-running
 * re-stamps the daemon URL.
 */
export async function installGlobalRecorder(options: {
  daemonUrl: string;
  pluginBundlePath: string;
}): Promise<{ pluginPath: string }> {
  if (!(await pathExists(options.pluginBundlePath))) {
    throw new Error(
      "Self-contained recorder bundle not found. Use the published npx package, or build it from source with `npm run build:cli`."
    );
  }
  const pluginPath = globalRecorderPath();
  const bundle = (await readFile(options.pluginBundlePath, "utf8")).replaceAll("__ABB_DAEMON_URL__", options.daemonUrl);
  await mkdir(dirname(pluginPath), { recursive: true });
  await writeFile(pluginPath, bundle, "utf8");
  return { pluginPath };
}

export async function uninstallGlobalRecorder(): Promise<{ pluginPath: string; removed: boolean }> {
  const pluginPath = globalRecorderPath();
  try {
    await rm(pluginPath);
    return { pluginPath, removed: true };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { pluginPath, removed: false };
    throw error;
  }
}

export async function initOpenCodeProject(options: InitOpenCodeOptions): Promise<InitOpenCodeResult> {
  const adapterPackage = options.adapterPackage ?? defaultAdapterPackage;
  const adapterImport = inferAdapterImport(adapterPackage);
  const daemonUrl = options.daemonUrl ?? defaultDaemonUrl;
  const opencodeDir = join(options.projectDir, ".opencode");
  const pluginsDir = join(opencodeDir, "plugins");
  const pluginPath = join(pluginsDir, "agent-blackbox.ts");
  const packageJsonPath = join(opencodeDir, "package.json");

  await mkdir(pluginsDir, { recursive: true });
  if (!options.force && (await pathExists(pluginPath))) {
    throw new Error(`${pluginPath} already exists. Re-run with --force to overwrite it.`);
  }

  // Self-contained (npx) mode: inline the bundled recorder, no dep to resolve.
  if (options.pluginBundlePath && (await pathExists(options.pluginBundlePath))) {
    const bundle = await readFile(options.pluginBundlePath, "utf8");
    const inlined = bundle.replaceAll("__ABB_DAEMON_URL__", daemonUrl);
    await writeFile(pluginPath, inlined, "utf8");
    return { pluginPath, packageJsonPath, adapterPackage, adapterImport };
  }

  await writeFile(pluginPath, renderOpenCodePlugin({ adapterImport, daemonUrl, optimize: options.optimize ?? false }), "utf8");
  await writePackageJson(packageJsonPath, adapterPackage, adapterImport);
  return {
    pluginPath,
    packageJsonPath,
    adapterPackage,
    adapterImport
  };
}

export function renderOpenCodePlugin(options: { adapterImport: string; daemonUrl: string; optimize?: boolean }): string {
  return `import { createOpenCodePlugin } from "${options.adapterImport}";

export const AgentBlackbox = createOpenCodePlugin({
  daemonUrl: process.env.AGENT_BLACKBOX_DAEMON_URL ?? "${options.daemonUrl}"${options.optimize ? ",\n  optimize: true" : ""}
});
`;
}

async function writePackageJson(packageJsonPath: string, adapterPackage: string, adapterImport: string): Promise<void> {
  const existing = await readPackageJson(packageJsonPath);
  const dependencies = {
    ...(existing.dependencies ?? {}),
    [adapterImport]: adapterPackage
  };
  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ ...existing, dependencies }, null, 2)}\n`,
    "utf8"
  );
}

function inferAdapterImport(adapterPackage: string): string {
  if (
    adapterPackage.startsWith("file:") ||
    adapterPackage.startsWith("/") ||
    adapterPackage.startsWith("./") ||
    adapterPackage.startsWith("../")
  ) {
    return defaultAdapterPackage;
  }
  return adapterPackage;
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  try {
    return JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
