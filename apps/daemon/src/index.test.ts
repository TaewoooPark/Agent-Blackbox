import { describe, expect, it } from "vitest";
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";

describe("daemon scaffold", () => {
  it("exposes a version and description", () => {
    expect(AGENT_BLACKBOX_DAEMON_VERSION).toBe("0.1.0");
    expect(describeDaemon()).toContain("Agent-Blackbox daemon");
  });
});

