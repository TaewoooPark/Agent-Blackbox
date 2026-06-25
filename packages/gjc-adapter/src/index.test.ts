import { describe, expect, it } from "vitest";
import { AGENT_BLACKBOX_GJC_ADAPTER_VERSION, defaultGjcSessionsDir, describeGjcAdapter } from "./index.js";

describe("gjc adapter scaffold", () => {
  it("exposes version, description, and default session directory", () => {
    expect(AGENT_BLACKBOX_GJC_ADAPTER_VERSION).toBe("0.1.0");
    expect(describeGjcAdapter()).toContain("Gajae-Code adapter");
    expect(defaultGjcSessionsDir("/home/alice")).toBe("/home/alice/.gjc/agent/sessions");
  });
});
