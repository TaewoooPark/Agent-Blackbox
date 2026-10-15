import { createClaudeNormalizer } from "@agent-blackbox/claude-code-adapter";
import { createCodexNormalizer } from "@agent-blackbox/codex-adapter";
import {
  computeEfficiencyReport,
  createTraceEvent,
  evaluatePromiseChecks,
  firstUserPrompt,
  generateHandoffMarkdown,
  materializeWorkflowGraph,
  traceEventKinds,
  type TraceEvent,
  type TraceEventInput
} from "@agent-blackbox/core";
import { createGjcNormalizer } from "@agent-blackbox/gjc-adapter";
import { createMotifcodeNormalizer } from "@agent-blackbox/motifcode-adapter";
import { createOpenCodeRecorder } from "@agent-blackbox/opencode-adapter";
import { describe, expect, it } from "vitest";

import { isReusableCommand } from "./optimize.js";

// A coverage table: for every core feature, what each host actually delivers.
//
// Three shipped bugs had the same shape — core logic written against one host's
// payloads, degrading silently on the others. The cache-hit ratio read `tokens.input`
// with OpenCode's meaning and so double-counted Claude Code's cache, pinning every run
// near 50%. The handoff printed "## Decisions — None recorded." for event kinds that no
// adapter has ever emitted. The optimize actuator's command filter was tuned to JS
// projects and pinned `curl`/`git clone` one-offs everywhere else. None of them threw;
// each produced a plausible wrong answer, which is why they survived review and live
// use.
//
// So assert the wiring itself. Each host normalizes the SAME physical session through
// its own real adapter, and the table below records which capability signals come out.
// A cell that goes false — a field an adapter stops emitting, a new host wired up
// without token telemetry — fails here instead of quietly degrading a score.

type Capability =
  | "objective" // handoff objective + run picker label
  | "tokenTelemetry" // context pressure, cache-hit, yield density
  | "cacheRatioTrue" // the ratio matches physical reality (v0.49.2)
  | "commandOutcome" // handoff failures, effectiveness, verified commands
  | "reusableCommand" // optimize can pin the project's test command (v0.49.1)
  | "fileReadSizes" // redundant reads, read amplification, big-file reads
  | "fileEdits" // yield density, exploration waste, effectiveness
  | "subagents"; // agent lanes / genealogy

// The session every host below performs, so the rows are comparable:
//   the user asks for something · an assistant turn reports tokens with a warm cache
//   (125,976 read / 1,973 written / 2 fresh — a 98.5% hit rate) · a file is read ·
//   the same file is edited · `npm test` passes · `npm run lint` fails.
const CACHE_READ = 125_976;
const CACHE_WRITE = 1973;
const FRESH = 2;
const TRUE_CACHE_RATIO = CACHE_READ / (CACHE_READ + CACHE_WRITE + FRESH);

const TS = "2026-07-27T00:00:00.000Z";
const materialize = (inputs: TraceEventInput[]): TraceEvent[] => inputs.map((input, i) => createTraceEvent(i + 1, input));

function claudeCodeSession(): TraceEvent[] {
  const n = createClaudeNormalizer({ defaultSessionId: "S1" });
  const assistant = (content: unknown[], usage?: Record<string, number>) => ({
    type: "assistant",
    sessionId: "S1",
    cwd: "/proj",
    timestamp: TS,
    message: { model: "claude-opus-5", content, ...(usage ? { usage } : {}) }
  });
  const toolResult = (id: string, result: unknown, isError = false) => ({
    type: "user",
    sessionId: "S1",
    cwd: "/proj",
    timestamp: TS,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
    toolUseResult: result
  });

  return materialize([
    ...n.consume({
      type: "user",
      sessionId: "S1",
      cwd: "/proj",
      timestamp: TS,
      promptSource: "typed", // injected/meta user lines are deliberately not prompts
      message: { role: "user", content: "Add a modulo operation" }
    }),
    ...n.consume(
      assistant([{ type: "text", text: "on it" }], {
        input_tokens: FRESH,
        output_tokens: 40,
        cache_read_input_tokens: CACHE_READ,
        cache_creation_input_tokens: CACHE_WRITE
      })
    ),
    ...n.consume(assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/proj/src/calc.ts" } }])),
    ...n.consume(toolResult("t1", { type: "text", file: { filePath: "/proj/src/calc.ts", content: "x".repeat(4000) } })),
    ...n.consume(assistant([{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/proj/src/calc.ts", new_string: "y".repeat(200) } }])),
    ...n.consume(toolResult("t2", { filePath: "/proj/src/calc.ts", newString: "y".repeat(200) })),
    ...n.consume(assistant([{ type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test" } }])),
    ...n.consume(toolResult("t3", { stdout: "2 passed" })),
    ...n.consume(assistant([{ type: "tool_use", id: "t4", name: "Bash", input: { command: "npm run lint" } }])),
    ...n.consume(toolResult("t4", { stdout: "1 problem" }, true)),
    ...n.consume(assistant([{ type: "tool_use", id: "t5", name: "Task", input: { subagent_type: "explore", prompt: "map the repo" } }])),
    ...n.consume(toolResult("t5", { content: "done" }))
  ]);
}

function codexSession(): TraceEvent[] {
  const id = "019f64f4-4b7c-75e2-bb37-c285d74b2ddd";
  const n = createCodexNormalizer({ defaultSessionId: id, homeDir: "/home/u", projectDir: "/home/u/project" });
  const msg = (payload: Record<string, unknown>) => ({ timestamp: TS, type: "event_msg", payload });

  return materialize([
    ...n.consume({ timestamp: TS, type: "session_meta", payload: { id, session_id: id, cwd: "/home/u/project", source: "exec" } }),
    ...n.consume({ timestamp: TS, type: "turn_context", payload: { turn_id: "turn-1", cwd: "/home/u/project", model: "gpt-test" } }),
    ...n.consume(msg({ type: "user_message", message: "Add a modulo operation" })),
    // Codex reports input_tokens as the whole prompt, with cached_input_tokens inside it.
    ...n.consume(
      msg({
        type: "token_count",
        info: { last_token_usage: { input_tokens: CACHE_READ + CACHE_WRITE + FRESH, cached_input_tokens: CACHE_READ, output_tokens: 40 } }
      })
    ),
    ...n.consume(
      msg({
        type: "patch_apply_end",
        call_id: "c1",
        success: true,
        changes: { "/home/u/project/src/calc.ts": { type: "update", unified_diff: "-old\n+new" } }
      })
    ),
    ...n.consume(msg({ type: "exec_command_begin", call_id: "c2", command: ["bash", "-lc", "npm test"], cwd: "/home/u/project" })),
    ...n.consume(msg({ type: "exec_command_end", call_id: "c2", exit_code: 0, stdout: "2 passed", duration: { secs: 1 } })),
    ...n.consume(msg({ type: "exec_command_begin", call_id: "c3", command: ["bash", "-lc", "npm run lint"], cwd: "/home/u/project" })),
    ...n.consume(msg({ type: "exec_command_end", call_id: "c3", exit_code: 1, stdout: "1 problem", duration: { secs: 1 } })),
    ...n.consume(msg({ type: "exec_command_begin", call_id: "c4", command: ["bash", "-lc", "cat src/calc.ts"], cwd: "/home/u/project" })),
    ...n.consume(msg({ type: "exec_command_end", call_id: "c4", exit_code: 0, stdout: "x".repeat(4000), duration: { secs: 1 } }))
  ]);
}

function gjcSession(): TraceEvent[] {
  const n = createGjcNormalizer({ defaultSessionId: "sess-1", homeDir: "/home/a", projectDir: "/home/a/project" });
  const tool = (id: string, name: string, input: Record<string, unknown>, output: unknown) => [
    ...n.consume({ type: "tool_call", id, name, input, timestamp: TS }),
    ...n.consume({ type: "tool_result", toolCallId: id, output, timestamp: TS })
  ];

  return materialize([
    ...n.consume({ type: "session", version: 3, id: "sess-1", timestamp: TS, cwd: "/home/a/project" }),
    ...n.consume({ type: "message", timestamp: TS, message: { role: "user", content: [{ type: "text", text: "Add a modulo operation" }] } }),
    ...n.consume({
      type: "message",
      timestamp: TS,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "on it" }],
        usage: { input_tokens: FRESH, output_tokens: 40, cache_read_input_tokens: CACHE_READ, cache_creation_input_tokens: CACHE_WRITE }
      }
    }),
    ...tool("r1", "read", { path: "/home/a/project/src/calc.ts" }, { content: "x".repeat(4000) }),
    ...tool("e1", "edit", { path: "/home/a/project/src/calc.ts", replacement: "y".repeat(200) }, {}),
    ...tool("b1", "bash", { command: "npm test" }, { stdout: "2 passed", stderr: "" }),
    ...tool("b2", "bash", { command: "npm run lint" }, { stdout: "", stderr: "1 problem", is_error: true })
  ]);
}

// Motifcode 0.4.1 journal v2: scopes share one file, usage is reported separately
// from assistant content, and cachedTokens is included in promptTokens.
function motifcodeSession(): TraceEvent[] {
  const n = createMotifcodeNormalizer({ defaultSessionId: "motif-cov" });
  let seq = 0;
  const record = (record: Record<string, unknown>, child = false) => n.consume({
    v: 2, seq: ++seq, at: TS, runId: "motif-cov",
    scopeId: child ? "review-1" : "root", scopeKind: child ? "subagent" : "root",
    ...(child ? { parentScopeId: "root", agentName: "review" } : {}), record
  });
  const event = (event: Record<string, unknown>) => record({ t: "event", event });
  const tool = (id: string, name: string, args: Record<string, unknown>, output: string, ok = true) => [
    ...event({ type: "tool_start", call: { id, name, arguments: args, repaired: false, validated: true } }),
    ...event({ type: "tool_end", id, ok, output, ms: 5 })
  ];
  return materialize([
    ...n.consume({ t: "header", header: {
      schemaVersion: 2, runId: "motif-cov", startedAt: TS,
      repository: { cwd: "/proj" }, model: { id: "motif/motif-3" }, harness: { version: "0.4.1" }
    } }),
    ...record({ t: "scope_start", task: "Add a modulo operation", initialMessages: [{ role: "user", content: "Add a modulo operation" }] }),
    ...event({ type: "session_start", model: "motif/motif-3", channel: "toolcall", tools: ["read", "write", "bash"] }),
    ...event({ type: "usage", contextTokens: 32_000, kvBytes: 100,
      promptTokens: CACHE_READ + CACHE_WRITE + FRESH, completionTokens: 40, cachedTokens: CACHE_READ, requestMs: 250 }),
    ...tool("r1", "read", { path: "src/calc.ts" }, "x".repeat(4000)),
    ...tool("e1", "write", { path: "src/calc.ts", content: "y".repeat(200) }, "replaced src/calc.ts (1 lines, 200 bytes)"),
    ...tool("b1", "bash", { command: "npm test" }, "2 passed"),
    ...tool("b2", "bash", { command: "npm run lint" }, "1 problem", false),
    ...record({ t: "scope_start", task: "Review the patch", initialMessages: [{ role: "user", content: "Review the patch" }] }, true)
  ]);
}

async function openCodeSession(): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const recorder = await createOpenCodeRecorder(
    { directory: "/repo" },
    { runId: "run-cov", sink: { async write(event) { events.push(event); } } }
  );
  const sessionID = "session-cov";
  await recorder.event({ event: { type: "session.created", sessionID } });
  await recorder.event({
    event: { type: "message.updated", properties: { info: { id: "m1", sessionID, role: "user", text: "Add a modulo operation" } } }
  });
  // OpenCode reports `input` as the uncached remainder, cache counted alongside.
  await recorder.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "m2",
          sessionID,
          role: "assistant",
          modelID: "claude-opus-5",
          tokens: { input: FRESH, output: 40, reasoning: 0, cache: { read: CACHE_READ, write: CACHE_WRITE } }
        }
      }
    }
  });
  const call = async (tool: string, args: Record<string, unknown>, output: Record<string, unknown>) => {
    await recorder["tool.execute.before"]({ tool, sessionID }, { args });
    await recorder["tool.execute.after"]({ tool, sessionID, args }, output);
  };
  await call("read", { filePath: "/repo/src/calc.ts" }, { output: "x".repeat(4000) });
  await call("edit", { filePath: "/repo/src/calc.ts", newString: "y".repeat(200) }, { output: "ok" });
  await call("bash", { command: "npm test" }, { output: "2 passed", metadata: { exit: 0 } });
  await call("bash", { command: "npm run lint" }, { output: "1 problem", metadata: { exit: 1 } });
  await call("task", { subagent_type: "explore", prompt: "map the repo" }, { output: "done" });
  return events;
}

function capabilities(events: TraceEvent[]): Record<Capability, boolean> {
  const report = computeEfficiencyReport(events);
  const cache = report.metrics.find((m) => m.id === "cache-hit");
  const bash = events.filter((e) => e.kind === "bash");
  const commands = bash.map((e) => String((e.payload as Record<string, unknown>).command ?? ""));
  return {
    objective: firstUserPrompt(events) !== undefined,
    tokenTelemetry: report.estimated === false,
    cacheRatioTrue: cache !== undefined && Math.abs(cache.value - TRUE_CACHE_RATIO) < 0.02,
    commandOutcome: bash.some((e) => (e.payload as Record<string, unknown>).exitCode !== undefined),
    reusableCommand: commands.some((command) => isReusableCommand(command)),
    fileReadSizes: events.some((e) => e.kind === "file_read" && Number((e.payload as Record<string, unknown>).chars) > 0),
    fileEdits: events.some((e) => e.kind === "file_edit" || e.kind === "file_created"),
    subagents: events.some((e) => e.kind === "subagent_spawned" || (e.kind === "agent_start" && e.agentRole === "subagent"))
  };
}

// Gaps this table measured, each confirmed in the adapter that causes it. They are
// named rather than hidden so the next change either closes one deliberately (delete
// the entry, flip the cell) or trips over it. A silently closed gap fails here too —
// an adapter that starts emitting something core depends on should be a decision.
// Both gaps this table first measured are closed in 0.50.0 — the entries are gone, and
// the cells below are true. The mechanism stays: a gap that closes silently fails here
// too, because an adapter that starts emitting something core depends on should be a
// decision, not a surprise.
const KNOWN_GAPS = {} as const;

describe("host coverage — what each adapter actually delivers to core", () => {
  it("records the capability table for every supported host", async () => {
    const table = {
      "claude-code": capabilities(claudeCodeSession()),
      codex: capabilities(codexSession()),
      gjc: capabilities(gjcSession()),
      motifcode: capabilities(motifcodeSession()),
      opencode: capabilities(await openCodeSession())
    };

    // Update this table deliberately, never to make a red build green: a cell flipping
    // to false means a core feature silently stopped working for that host.
    expect(table).toEqual({
      "claude-code": {
        objective: true,
        tokenTelemetry: true,
        cacheRatioTrue: true,
        commandOutcome: true,
        reusableCommand: true,
        fileReadSizes: true,
        fileEdits: true,
        subagents: true
      },
      codex: {
        objective: true,
        tokenTelemetry: true,
        cacheRatioTrue: true,
        commandOutcome: true,
        reusableCommand: true,
        fileReadSizes: true,
        fileEdits: true,
        subagents: false // no delegation primitive in the rollout transcript
      },
      gjc: {
        objective: true,
        tokenTelemetry: true,
        cacheRatioTrue: true,
        commandOutcome: true,
        reusableCommand: true,
        fileReadSizes: true,
        fileEdits: true,
        subagents: false
      },
      motifcode: {
        objective: true,
        tokenTelemetry: true,
        cacheRatioTrue: true,
        commandOutcome: true,
        reusableCommand: true,
        fileReadSizes: true,
        fileEdits: true,
        subagents: true
      },
      opencode: {
        objective: true,
        tokenTelemetry: true,
        cacheRatioTrue: true,
        commandOutcome: true,
        reusableCommand: true,
        fileReadSizes: true,
        fileEdits: true,
        subagents: true
      }
    });
  });

  it("scores one physical session the same however the host describes it", async () => {
    // The bug this pins: the hosts disagree about whether `tokens.input` includes the
    // cache, so reading it raw made the same 98.5%-cached turn score 49.6% on one host
    // and 98.5% on another.
    const sessions = {
      "claude-code": claudeCodeSession(),
      codex: codexSession(),
      gjc: gjcSession(),
      motifcode: motifcodeSession(),
      opencode: await openCodeSession()
    };
    for (const [host, events] of Object.entries(sessions)) {
      const report = computeEfficiencyReport(events);
      if (report.estimated) {
        expect(KNOWN_GAPS[`${host}/tokenTelemetry` as keyof typeof KNOWN_GAPS], `${host} silently lost telemetry`).toBe(true);
        continue;
      }
      const cache = report.metrics.find((m) => m.id === "cache-hit");
      expect(Math.round((cache?.value ?? 0) * 100), host).toBe(Math.round(TRUE_CACHE_RATIO * 100));
      expect(cache?.status, host).toBe("good");
    }
  });

  it("keeps the handoff free of sections no host can fill", async () => {
    // `decision_extracted` and `blocker_detected` are declared in core and handled by
    // the graph, but emitted by nobody — the handoff used to print "None recorded." for
    // them on every run. If an adapter ever starts emitting one, delete it from here
    // and give it back its section.
    const unemitted: TraceEvent["kind"][] = [
      "decision_extracted",
      "blocker_detected",
      "agent_end",
      "file_deleted",
      "handoff_generated"
    ];
    const sessions = [claudeCodeSession(), codexSession(), gjcSession(), await openCodeSession(), motifcodeSession()];
    const emitted = new Set(sessions.flat().map((event) => event.kind));
    for (const kind of unemitted) expect(emitted.has(kind), `${kind} is now emitted`).toBe(false);

    for (const [host, events] of Object.entries({
      "claude-code": sessions[0]!,
      codex: sessions[1]!,
      gjc: sessions[2]!,
      opencode: sessions[3]!,
      motifcode: sessions[4]!
    })) {
      const markdown = generateHandoffMarkdown(materializeWorkflowGraph(events), evaluatePromiseChecks(events), events);
      expect(markdown, host).not.toContain("None recorded");
      expect(markdown, host).not.toContain("## Decisions");
      if (KNOWN_GAPS[`${host}/objective` as keyof typeof KNOWN_GAPS]) {
        expect(markdown, host).toContain("Not captured in the recorded events");
      } else {
        expect(markdown, host).toContain("Add a modulo operation");
      }
    }
  });

  it("declares no event kind that the graph cannot render", () => {
    // A kind in the union with no graph handler is a node that would vanish from the
    // map. The graph falls back to a labelled node, so this only asserts the union is
    // the single source of truth both sides share.
    expect(new Set(traceEventKinds).size).toBe(traceEventKinds.length);
  });
});
