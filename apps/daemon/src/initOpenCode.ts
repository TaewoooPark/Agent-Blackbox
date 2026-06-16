import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type InitOpenCodeOptions = {
  projectDir: string;
  daemonUrl?: string;
  adapterPackage?: string;
  force?: boolean;
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

  await writeFile(pluginPath, renderOpenCodePlugin({ adapterImport, daemonUrl }), "utf8");
  await writePackageJson(packageJsonPath, adapterPackage, adapterImport);
  return {
    pluginPath,
    packageJsonPath,
    adapterPackage,
    adapterImport
  };
}

export function renderOpenCodePlugin(options: { adapterImport: string; daemonUrl: string }): string {
  return `import { createOpenCodePlugin } from "${options.adapterImport}";

export const AgentBlackbox = createOpenCodePlugin({
  daemonUrl: process.env.AGENT_BLACKBOX_DAEMON_URL ?? "${options.daemonUrl}"
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
