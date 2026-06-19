import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  globalRecorderPath,
  initOpenCodeProject,
  installGlobalRecorder,
  renderOpenCodePlugin,
  uninstallGlobalRecorder
} from "./initOpenCode.js";

let tempDir: string | undefined;
let savedXdg: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

describe("init-opencode", () => {
  it("renders a project-local OpenCode plugin", () => {
    expect(
      renderOpenCodePlugin({
        adapterImport: "@agent-blackbox/opencode-adapter",
        daemonUrl: "http://127.0.0.1:47831"
      })
    ).toContain("createOpenCodePlugin");
  });

  it("writes plugin and package config without overwriting by default", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-init-"));

    const result = await initOpenCodeProject({
      projectDir: tempDir,
      adapterPackage: "file:/local/adapter",
      daemonUrl: "http://127.0.0.1:4999"
    });

    const plugin = await readFile(result.pluginPath, "utf8");
    expect(plugin).toContain('from "@agent-blackbox/opencode-adapter"');
    expect(plugin).not.toContain("file:/local/adapter");
    expect(plugin).toContain("http://127.0.0.1:4999");
    expect(result.adapterImport).toBe("@agent-blackbox/opencode-adapter");
    const packageJson = JSON.parse(await readFile(result.packageJsonPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies["@agent-blackbox/opencode-adapter"]).toBe("file:/local/adapter");
    await expect(initOpenCodeProject({ projectDir: tempDir })).rejects.toThrow("already exists");
  });

  it("preserves existing package dependencies", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-init-"));
    const opencodeDir = join(tempDir, ".opencode");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, "package.json"),
      JSON.stringify({ dependencies: { shescape: "^2.1.0" } }),
      "utf8"
    );

    await initOpenCodeProject({ projectDir: tempDir });

    const packageJson = JSON.parse(await readFile(join(opencodeDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.shescape).toBe("^2.1.0");
    expect(packageJson.dependencies["@agent-blackbox/opencode-adapter"]).toBe("@agent-blackbox/opencode-adapter");
  });

  it("installs and removes the global recorder (the all-sessions path)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-global-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir; // → <tempDir>/opencode/plugins/agent-blackbox.js

    // Stand in for the npx self-contained bundle (carries the URL placeholder).
    const bundlePath = join(tempDir, "bundle.mjs");
    await writeFile(bundlePath, 'export const AgentBlackbox = { daemonUrl: "__ABB_DAEMON_URL__" };\n', "utf8");

    const expectedPath = join(tempDir, "opencode", "plugins", "agent-blackbox.js");
    expect(globalRecorderPath()).toBe(expectedPath);

    const { pluginPath } = await installGlobalRecorder({ daemonUrl: "http://127.0.0.1:47880", pluginBundlePath: bundlePath });
    expect(pluginPath).toBe(expectedPath);
    const written = await readFile(pluginPath, "utf8");
    expect(written).toContain("http://127.0.0.1:47880"); // placeholder stamped
    expect(written).not.toContain("__ABB_DAEMON_URL__");

    expect(await uninstallGlobalRecorder()).toEqual({ pluginPath: expectedPath, removed: true });
    expect(await uninstallGlobalRecorder()).toEqual({ pluginPath: expectedPath, removed: false });
  });

  it("rejects a global install without the self-contained bundle", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-blackbox-global-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;
    await expect(
      installGlobalRecorder({ daemonUrl: "http://127.0.0.1:47831", pluginBundlePath: join(tempDir, "missing.mjs") })
    ).rejects.toThrow(/bundle/i);
  });
});
