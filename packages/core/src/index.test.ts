import { describe, expect, it } from "vitest";
import { AGENT_BLACKBOX_CORE_VERSION, describeCore } from "./index.js";

describe("core scaffold", () => {
  it("exposes a version and description", () => {
    expect(AGENT_BLACKBOX_CORE_VERSION).toBe("0.1.0");
    expect(describeCore()).toContain("Agent-Blackbox core");
  });
});

