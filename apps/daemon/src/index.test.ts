import { describe, expect, it } from "vitest";
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";

describe("daemon scaffold", () => {
  it("exposes a version and description", () => {
    // Resolved from the nearest package.json (single source of truth), so assert
    // it's a real semver rather than a hardcoded constant that drifts from npm.
    expect(AGENT_BLACKBOX_DAEMON_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(describeDaemon()).toContain("Agent-Blackbox daemon");
  });
});

