import { describe, expect, it } from "vitest";
import { AGENT_BLACKBOX_STORAGE_VERSION, describeStorage } from "./index.js";

describe("storage scaffold", () => {
  it("exposes a version and description", () => {
    expect(AGENT_BLACKBOX_STORAGE_VERSION).toBe("0.1.0");
    expect(describeStorage()).toContain("Agent-Blackbox storage");
  });
});

