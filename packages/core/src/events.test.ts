import { describe, expect, it } from "vitest";
import {
  assertTraceEvent,
  createEventSequencer,
  createTraceEvent,
  makeTraceEventId,
  validateTraceEvent
} from "./events.js";

describe("trace events", () => {
  it("creates deterministic ids from run id and sequence", () => {
    expect(makeTraceEventId("run:alpha", 7)).toBe("evt_run_alpha_000007");
  });

  it("marks tool events as observed evidence", () => {
    const event = createTraceEvent(1, {
      host: "opencode",
      runId: "run-1",
      sessionId: "session-1",
      kind: "tool_call",
      payload: { tool: "bash" }
    });

    expect(event.evidence).toEqual({ observed: true, claimedByModel: false });
    expect(validateTraceEvent(event).ok).toBe(true);
  });

  it("marks model messages as claims by default", () => {
    const event = createTraceEvent(1, {
      host: "opencode",
      runId: "run-1",
      sessionId: "session-1",
      kind: "message",
      payload: { role: "assistant", text: "I ran the tests." }
    });

    expect(event.evidence).toEqual({ observed: false, claimedByModel: true });
  });

  it("increments sequences through a run-local sequencer", () => {
    const sequencer = createEventSequencer({
      host: "opencode",
      runId: "run-2",
      sessionId: "session-2"
    });

    const first = sequencer.next({ kind: "session_created" });
    const second = sequencer.next({ kind: "turn_start", turnId: "turn-1" });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.id).toBe("evt_run-2_000002");
    expect(sequencer.currentSeq()).toBe(2);
  });

  it("rejects malformed events", () => {
    const result = validateTraceEvent({ id: "x" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ts must be a non-empty string");
    expect(() => assertTraceEvent({ id: "x" })).toThrow("Invalid trace event");
  });

  it("type-checks optional identity/lane fields a POSTed event could forge", () => {
    const base = createTraceEvent(1, {
      host: "opencode",
      runId: "run-1",
      sessionId: "session-1",
      kind: "tool_call",
      payload: { tool: "bash" }
    });
    // The graph branches on agentRole and reparents on parentSessionId, so a forged
    // non-enum role or non-string id must be rejected at the gate.
    expect(validateTraceEvent({ ...base, agentRole: "root" }).ok).toBe(false);
    expect(validateTraceEvent({ ...base, parentSessionId: 42 }).ok).toBe(false);
    expect(validateTraceEvent({ ...base, agentId: { evil: true } }).ok).toBe(false);
    // Valid optional fields, and their absence, both pass.
    expect(validateTraceEvent({ ...base, agentRole: "subagent", parentSessionId: "s0", agentLabel: "build" }).ok).toBe(true);
    expect(validateTraceEvent(base).ok).toBe(true);
  });
});

