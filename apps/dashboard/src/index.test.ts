import { describe, expect, it } from "vitest";
import { AGENT_BLACKBOX_DASHBOARD_VERSION, describeDashboard } from "./index.js";

describe("dashboard scaffold", () => {
  it("exposes a version and description", () => {
    expect(AGENT_BLACKBOX_DASHBOARD_VERSION).toBe("0.1.0");
    expect(describeDashboard()).toContain("Agent-Blackbox dashboard");
  });
});

