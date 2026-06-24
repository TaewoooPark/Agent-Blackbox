import { expect, test } from "@playwright/test";

// Import the BUILT core directly by path (e2e isn't a workspace, so this avoids a
// dependency edge) to mint valid TraceEvents.
import { createTraceEvent } from "../packages/core/dist/index.js";

import { DAEMON_PORT } from "./ports.js";

const DAEMON = `http://127.0.0.1:${DAEMON_PORT}`;
const cwd = "C:\\proj"; // a Windows drive-letter cwd, like a native Windows session

const ev = (seq: number, kind: string, payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "claude-code", runId: "win-demo", sessionId: "win-demo", kind: kind as never, payload: payload as never, cwd });

// A small session with backslash file paths — the exact shape native Windows Claude
// Code emits — so the map, file tree, and connection arcs are exercised with "\".
const SEED = [
  ev(1, "message", { role: "user", text: "Add a modulo operation to the ledger and run the tests." }),
  ev(2, "file_read", { path: "C:\\proj\\src\\ledger.ts", chars: 4200 }),
  ev(3, "file_read", { path: "C:\\proj\\src\\parser.ts", chars: 3100 }),
  ev(4, "file_edit", { path: "C:\\proj\\src\\ledger.ts", chars: 320 }),
  ev(5, "bash", { command: "npm test", description: "Run the test suite", exitCode: 0 })
];

test("renders the session map + file tree from Windows-shaped (C:\\) events", async ({ page }) => {
  for (const event of SEED) {
    const res = await page.request.post(`${DAEMON}/events`, { data: event });
    expect(res.status()).toBe(202);
  }

  await page.goto("/");
  // The map materializes from the seeded events.
  await page.waitForSelector(".treeNode", { timeout: 30_000 });

  // The FILES panel segmented the backslash paths into real rows (the Windows bug we
  // fixed would have collapsed "C:\proj\src\ledger.ts" into one mangled chunk).
  const fileAnchors = page.locator("[data-file-anchor-path]");
  await expect(fileAnchors.first()).toBeVisible({ timeout: 30_000 });
  // The backslash path "C:\proj\src\ledger.ts" became real, segmented rows ending in
  // the filename — proof the separator fix renders on Windows (the bug collapsed it
  // into one mangled chunk).
  const paths = await fileAnchors.evaluateAll((els) => els.map((el) => el.getAttribute("data-file-anchor-path")));
  expect(paths.some((p) => p !== null && /ledger\.ts$/.test(p))).toBeTruthy();

  await page.screenshot({ path: "artifacts/windows-session-map.png", fullPage: true });
});
