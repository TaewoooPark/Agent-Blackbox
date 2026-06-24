import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { DAEMON_PORT, UI_PORT } from "./ports.js";

const here = dirname(fileURLToPath(import.meta.url));

// Boot the REAL product entry point (`up`) — same daemon + dashboard a user runs —
// on real Windows, then drive it with a browser and capture the render. XDG_DATA_HOME
// is pinned to a temp dir so the run is hermetic.
export default defineConfig({
  testDir: here,
  outputDir: join(here, "artifacts"),
  timeout: 90_000,
  reporter: [["html", { outputFolder: join(here, "playwright-report"), open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${UI_PORT}`,
    screenshot: "on",
    video: "on",
    trace: "on"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ../apps/daemon/dist/cli.js up --host claude-code --port ${DAEMON_PORT} --ui-port ${UI_PORT} --no-open --suggest off`,
    cwd: here,
    url: `http://127.0.0.1:${UI_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      XDG_DATA_HOME: join(here, ".abb-data"),
      CLAUDE_CONFIG_DIR: join(here, ".abb-cfg")
    }
  }
});
