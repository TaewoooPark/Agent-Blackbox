import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All side-effectful startup pieces are replaced: in particular --host all must
// never install a plugin or hooks in the developer's real agent configuration.
const mocks = vi.hoisted(() => {
  const motifStop = vi.fn();
  const claudeStop = vi.fn();
  const codexStop = vi.fn();
  const gjcStop = vi.fn();
  const daemonClose = vi.fn();
  const ingest = vi.fn();
  return {
    motifStop, claudeStop, codexStop, gjcStop, daemonClose, ingest,
    motifStart: vi.fn(async (..._args: unknown[]) => ({ sessionsDir: "/sessions/motifcode", stop: motifStop })),
    claudeStart: vi.fn(async (..._args: unknown[]) => ({ projectsDir: "/sessions/claude", stop: claudeStop })),
    codexStart: vi.fn(async (..._args: unknown[]) => ({ sessionsDir: "/sessions/codex", stop: codexStop })),
    gjcStart: vi.fn(async (..._args: unknown[]) => ({ sessionsDir: "/sessions/gjc", stop: gjcStop })),
    daemonStart: vi.fn(async (..._args: unknown[]) => ({ port: 47831, eventsFile: "/trace/events.ndjson", ingest, close: daemonClose })),
    dashboardStart: vi.fn(async (..._args: unknown[]) => ({ port: 5173, close: vi.fn() })),
    installGlobal: vi.fn(async (..._args: unknown[]) => ({ pluginPath: "/config/plugin.js" })),
    installProject: vi.fn(async (..._args: unknown[]) => ({ pluginPath: "/project/.opencode/plugin.js" }))
  };
});

vi.mock("@agent-blackbox/motifcode-adapter", () => ({ startMotifcodeTailer: mocks.motifStart }));
vi.mock("@agent-blackbox/claude-code-adapter", () => ({ startClaudeCodeTailer: mocks.claudeStart }));
vi.mock("@agent-blackbox/codex-adapter", () => ({ startCodexTailer: mocks.codexStart }));
vi.mock("@agent-blackbox/gjc-adapter", () => ({ startGjcTailer: mocks.gjcStart }));
vi.mock("./server.js", () => ({ startTraceDaemon: mocks.daemonStart }));
vi.mock("./dashboardServer.js", () => ({ startDashboardServer: mocks.dashboardStart }));
vi.mock("./initOpenCode.js", () => ({ installGlobalRecorder: mocks.installGlobal, initOpenCodeProject: mocks.installProject }));
vi.mock("./initClaudeHooks.js", () => ({ installClaudeCodeHooks: vi.fn(), uninstallClaudeCodeHooks: vi.fn() }));
vi.mock("./initCodexHooks.js", () => ({ installCodexHooks: vi.fn(), uninstallCodexHooks: vi.fn() }));
vi.mock("./optimize.js", () => ({ runOptimize: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: () => true
}));

let tempDir: string;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  tempDir = await mkdtemp(join(tmpdir(), "abb-cli-hosts-"));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  vi.stubEnv("XDG_DATA_HOME", join(tempDir, "data"));
  vi.stubEnv("XDG_CONFIG_HOME", join(tempDir, "config"));
  vi.stubEnv("AGENT_BLACKBOX_HOST", "opencode");
  vi.stubEnv("AGENT_BLACKBOX_BACKFILL_DAYS", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  process.argv = [process.execPath, "agent-blackbox", "up", "--no-open", "--suggest", "off", ...args];
  await import("./cli.js");
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith("Press Ctrl+C to stop the daemon + dashboard."));
}

describe("CLI host startup", () => {
  it("records Motifcode alone and forwards its events to the scoped daemon", async () => {
    await run("--host", "motifcode", "--backfill-days", "3");
    expect(mocks.motifStart).toHaveBeenCalledWith(expect.anything(), { backfillDays: 3, projectDir: process.cwd() });
    expect(mocks.daemonStart).toHaveBeenCalledWith(expect.objectContaining({ recordHosts: ["motifcode"] }));
    expect(mocks.installGlobal).not.toHaveBeenCalled();
    expect(mocks.installProject).not.toHaveBeenCalled();
    expect(mocks.claudeStart).not.toHaveBeenCalled();
    expect(mocks.codexStart).not.toHaveBeenCalled();
    expect(mocks.gjcStart).not.toHaveBeenCalled();
    const sink = mocks.motifStart.mock.calls[0]![0] as { write: (event: unknown) => unknown };
    const event = { host: "motifcode", kind: "session_created" };
    sink.write(event);
    expect(mocks.ingest).toHaveBeenCalledWith(event);
  });

  it("includes Motifcode alongside every existing recorder for --host all", async () => {
    await run("--host", "all", "--motifcode-sessions-dir", "relative-sessions");
    expect(mocks.motifStart).toHaveBeenCalledWith(expect.anything(), {
      backfillDays: 0, projectDir: process.cwd(), sessionsDir: resolve("relative-sessions")
    });
    for (const start of [mocks.claudeStart, mocks.codexStart, mocks.gjcStart, mocks.installGlobal]) {
      expect(start).toHaveBeenCalledOnce();
    }
    expect(mocks.daemonStart.mock.calls[0]![0]).not.toHaveProperty("recordHosts");
  });

  it.each(["motifcode", "all"])("honors --project for --host %s without installing a global OpenCode plugin", async (host) => {
    await run("--host", host, "--project", tempDir);
    expect(mocks.motifStart).toHaveBeenCalledWith(expect.anything(), { backfillDays: 0, projectDir: tempDir });
    expect(mocks.daemonStart).toHaveBeenCalledWith(expect.objectContaining({
      projectDir: tempDir,
      eventsFile: join(tempDir, ".agent-blackbox", "events.ndjson")
    }));
    expect(mocks.installGlobal).not.toHaveBeenCalled();
    if (host === "all") {
      expect(mocks.installProject).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir }));
    } else {
      expect(mocks.installProject).not.toHaveBeenCalled();
    }
  });

  it("preserves the project-local OpenCode default", async () => {
    await run("--project", tempDir);
    expect(mocks.installProject).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir, force: false }));
    expect(mocks.installGlobal).not.toHaveBeenCalled();
    expect(mocks.motifStart).not.toHaveBeenCalled();
  });

  it("accepts Motifcode through AGENT_BLACKBOX_HOST", async () => {
    vi.stubEnv("AGENT_BLACKBOX_HOST", "motifcode");
    await run();
    expect(mocks.motifStart).toHaveBeenCalledOnce();
    expect(mocks.installGlobal).not.toHaveBeenCalled();
  });

  it("stops Motifcode and the other started tailers when dashboard startup fails", async () => {
    mocks.dashboardStart.mockRejectedValueOnce(new Error("Dashboard port is busy"));
    process.argv = [process.execPath, "agent-blackbox", "up", "--host", "all", "--no-open"];
    await import("./cli.js");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("Dashboard port is busy"));
    for (const stop of [mocks.motifStop, mocks.claudeStop, mocks.codexStop, mocks.gjcStop, mocks.daemonClose]) {
      expect(stop).toHaveBeenCalledOnce();
    }
    expect(mocks.motifStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.daemonClose.mock.invocationCallOrder[0]!);
    expect(process.exitCode).toBe(1);
  });
});
