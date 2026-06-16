import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initOpenCodeProject, renderOpenCodePlugin } from "./initOpenCode.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("init-opencode", () => {
  it("renders a project-local OpenCode plugin", () => {
    expect(
      renderOpenCodePlugin({
        adapterPackage: "@agent-blackbox/opencode-adapter",
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

    expect(await readFile(result.pluginPath, "utf8")).toContain("http://127.0.0.1:4999");
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
});

