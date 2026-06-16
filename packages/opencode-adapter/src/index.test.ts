import { describe, expect, it } from "vitest";
import {
  AGENT_BLACKBOX_OPENCODE_ADAPTER_VERSION,
  describeOpenCodeAdapter
} from "./index.js";

describe("opencode adapter scaffold", () => {
  it("exposes a version and description", () => {
    expect(AGENT_BLACKBOX_OPENCODE_ADAPTER_VERSION).toBe("0.1.0");
    expect(describeOpenCodeAdapter()).toContain("OpenCode adapter");
  });
});

