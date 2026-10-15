#!/usr/bin/env node
/**
 * Opt-in integration against an installed Motifcode CLI (verified with 0.4.2).
 *   npm run build
 *   node e2e/motifcode-integration.mjs --motif-bin /absolute/path/to/motif [--keep]
 *
 * This executes the real CLI, tool executor and journal writer against a local
 * OpenAI-compatible scripted provider. It never needs a model key or reads the
 * caller's Motifcode configuration. The child's HOME is an isolated directory;
 * the parent environment is unchanged. Temporary artifacts are removed unless
 * --keep is supplied. No Motifcode install is required by the ordinary CI suite.
 *
 * Compaction and permission dialogs are outside this one-shot CLI test:
 * Motifcode 0.4.2 wires those callbacks only in its interactive session. Their
 * adapter contract tests are not claimed as live CLI coverage here.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WebSocket } from "ws";
import { startTraceDaemon } from "../apps/daemon/dist/server.js";
import { startMotifcodeTailer } from "../packages/motifcode-adapter/dist/index.js";
import { createHttpTraceSink } from "../packages/opencode-adapter/dist/sink.js";

const argv = process.argv.slice(2);
const binIndex = argv.indexOf("--motif-bin");
assert(binIndex >= 0 && argv[binIndex + 1], "Pass --motif-bin /absolute/path/to/installed/motif (after npm run build).");
const motifEntry = await realpath(resolve(argv[binIndex + 1]));
const keep = argv.includes("--keep");
const fixtureRoot = await mkdtemp(join(tmpdir(), "abb-motifcode-integration-"));
const fixtureHome = join(fixtureRoot, "home");
const emptyEnv = join(fixtureRoot, "empty.env");
await mkdir(fixtureHome, { recursive: true });
await writeFile(emptyEnv, "");
const childEnv = {
  PATH: process.env.PATH ?? dirname(process.execPath),
  HOME: fixtureHome,
  USERPROFILE: fixtureHome,
  TMPDIR: tmpdir(),
  TERM: "dumb",
  NO_COLOR: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(fixtureHome, "empty-git-config"),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
};
const cleanups = [];
const providerErrors = [];
const requests = [];
const installedPackage = JSON.parse(await readFile(join(dirname(motifEntry), "..", "package.json"), "utf8"));
assert.equal(installedPackage.name, "motifcode", "--motif-bin must point to the installed Motifcode package");
const report = { motifEntry, motifVersion: installedPackage.version, scenarios: [], skipped: ["interactive-only compaction", "interactive-only permission dialogs"] };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(predicate, label, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await pause(20);
  }
  throw new Error(`Timed out: ${label}`);
}
function deferred() {
  let resolveGate;
  const promise = new Promise((done) => { resolveGate = done; });
  return { promise, release: resolveGate };
}
const restartGate = deferred();
const liveGate = deferred();
let restartWaiting = false;
let liveWaiting = false;
let recovered = false;
const counters = new Map();
const tool = (name, args) => ({ name, args });
const done = (summary) => [tool("done", { summary }), tool("done", { summary, confirm: true })];
const successPlan = [
  tool("read", { path: "input.txt" }),
  tool("write", { path: "output.txt", content: "before\n" }),
  tool("apply_patch", { patch: "--- a/output.txt\n+++ b/output.txt\n@@ -1 +1 @@\n-before\n+after\n" }),
  tool("bash", { command: "printf 'expected failure\\n'; exit 7" }),
  tool("task", { agent: "explorer", prompt: "ABB_CHILD_SUCCESS" }),
  tool("bash", { command: "printf 'verified locally\\n'" }),
  ...done("Verified the scripted integration task.")
];
const provider = createServer((req, res) => {
  void (async () => {
    assert.equal(req.method, "POST");
    assert.match(req.url ?? "", /^\/(success|child-failure|recovery|restart)\/v1\/chat\/completions$/);
    assert.equal(req.headers.authorization, undefined, "isolated CLI must not send a credential");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.model, "abb-scripted-model");
    assert.equal(body.stream, false, "one-shot piped CLI should use complete responses");
    assert(Array.isArray(body.messages));
    assert(Array.isArray(body.tools));
    const user = body.messages.find((message) => message.role === "user")?.content;
    const child = user === "ABB_CHILD_SUCCESS" || user === "ABB_CHILD_FAILURE";
    const scenario = req.url.split("/")[1];
    const key = `${scenario}:${child ? user : "root"}`;
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    requests.push({ scenario, scope: child ? user : "root", index });
    if ((scenario === "recovery" && !recovered) || user === "ABB_CHILD_FAILURE") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "scripted provider unavailable" } }));
      return;
    }
    let plan;
    if (user === "ABB_CHILD_SUCCESS") plan = [tool("read", { path: "input.txt" }), ...done("Read input.txt in the child scope.")];
    else if (scenario === "success") plan = successPlan;
    else if (scenario === "child-failure") plan = [tool("task", { agent: "reviewer", prompt: "ABB_CHILD_FAILURE" }), ...done("Child failed; parent completed its remaining work.")];
    else if (scenario === "recovery") plan = done("Model connection restored.");
    else plan = [tool("read", { path: "input.txt" }), tool("write", { path: "after-restart.txt", content: "survived recorder restart\n" }), ...done("Recorder restart preserved new work.")];
    const planIndex = scenario === "recovery" ? index - 1 : index;
    const action = plan[planIndex];
    assert(action, `Unexpected extra completion request: ${key} #${index}`);
    assert(body.tools.some((entry) => entry.function?.name === action.name), `tool ${action.name} unavailable in ${key}`);
    if (scenario === "restart" && index === 1) {
      restartWaiting = true;
      await restartGate.promise;
    }
    if (scenario === "success" && !child && index === 1) {
      liveWaiting = true;
      await liveGate.promise;
    }
    const usage = { prompt_tokens: 100 + requests.length, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } };
    requests.at(-1).usage = usage;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `completion-${requests.length}`, object: "chat.completion", model: body.model,
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant", content: "", reasoning_content: "scripted private reasoning",
        tool_calls: [{ id: `call-${index}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }]
      } }], usage
    }));
  })().catch((error) => {
    providerErrors.push(String(error));
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "integration provider assertion failed" } }));
  });
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
cleanups.push(async () => {
  restartGate.release();
  liveGate.release();
  provider.closeAllConnections();
  await new Promise((doneClose) => provider.close(doneClose));
});

async function project(name) {
  const directory = join(fixtureRoot, name);
  await mkdir(directory);
  await writeFile(join(directory, "input.txt"), "local fixture 🙂 한국어\n");
  return directory;
}
function runMotif(directory, scenario, task) {
  const args = ["--cwd", directory, "--env-file", emptyEnv, "--endpoint", `${providerOrigin}/${scenario}`, "--model", "abb-scripted-model", "--channel", "toolcall", "--channel-policy", "fixed", "--permissions", "auto", "--max-turns", "20", "--bash-timeout", "5", "--no-hero", task];
  const child = spawn(process.execPath, [motifEntry, ...args], { cwd: directory, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-12000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  const completed = new Promise((doneRun, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`Motifcode terminated by ${signal}\n${output}`));
      else doneRun({ code, output });
    });
  });
  // A failed assertion may start cleanup while a gated child is still running.
  // Keep its eventual shutdown rejection handled even before the caller awaits it.
  void completed.catch(() => undefined);
  cleanups.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return completed;
}
async function readJournals(directory) {
  const store = join(directory, ".motif", "sessions");
  const files = (await readdir(store)).filter((name) => name.endsWith(".jsonl"));
  return Promise.all(files.map(async (file) => ({ file, lines: (await readFile(join(store, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line)) })));
}
async function capture(directory) {
  const daemon = await startTraceDaemon({ projectDir: directory, port: 0, recordHosts: ["motifcode"] });
  const origin = `http://127.0.0.1:${daemon.port}`;
  const frames = [];
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/stream`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  socket.on("error", (error) => providerErrors.push(`WebSocket: ${error.message}`));
  await once(socket, "open");
  await waitFor(() => frames.some((frame) => frame.type === "snapshot"), "initial WebSocket snapshot");
  const warnings = [];
  const httpSink = createHttpTraceSink(origin, { onWarn: (warning) => warnings.push(warning) });
  let deliveries = 0;
  const sink = { write: async (event) => { await httpSink.write(event); deliveries++; } };
  let tailer = await startMotifcodeTailer(sink, { projectDir: directory, homeDir: fixtureHome, pollMs: 15 });
  cleanups.push(async () => { tailer.stop(); socket.terminate(); await daemon.close(); });
  const get = async (path) => {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    const payload = await response.json();
    assert.equal(payload.ok, true, path);
    return payload.data;
  };
  return {
    daemon, frames, warnings, get, events: () => get("/events"), deliveries: () => deliveries,
    restart: async (backfillDays = 0) => {
      tailer.stop();
      await pause(50);
      tailer = await startMotifcodeTailer(sink, { projectDir: directory, homeDir: fixtureHome, pollMs: 15, backfillDays });
    }
  };
}
async function completedEvents(captured, kind, count = 1) {
  return waitFor(async () => {
    const events = await captured.events();
    return events.filter((event) => event.kind === kind && event.agentRole !== "subagent").length >= count ? events : false;
  }, `${count} ${kind} event(s)`);
}
function verifyIdentity(events) {
  assert(events.every((event) => event.host === "motifcode"));
  assert.equal(new Set(events.map((event) => event.id)).size, events.length, "event IDs must be unique");
  for (const event of events) assert.equal(event.runId, event.sessionId);
}

try {
  const liveProject = await project("live");
  const live = await capture(liveProject);
  const liveRun = runMotif(liveProject, "success", "ABB_LIVE: exercise the installed CLI and its child scope.");
  await waitFor(() => liveWaiting, "live provider pause after first tool");
  await waitFor(() => live.frames.some((frame) => (frame.events ?? frame.data?.events ?? []).some((event) => event.kind === "file_read")), "pre-completion WebSocket event");
  liveGate.release();
  const run = await liveRun;
  assert.equal(run.code, 0, run.output);
  const events = await completedEvents(live, "session_idle");
  verifyIdentity(events);
  assert.equal(await readFile(join(liveProject, "output.txt"), "utf8"), "after\n");
  for (const kind of ["session_created", "turn_start", "tool_call", "file_read", "file_created", "file_edit", "bash", "agent_start", "agent_end", "session_idle"]) assert(events.some((event) => event.kind === kind), `missing ${kind}`);
  assert(events.some((event) => event.kind === "bash" && event.payload.success === false));
  const children = events.filter((event) => event.agentRole === "subagent");
  assert(children.length > 0 && children.every((event) => event.agentId && event.runId === events[0].runId));
  assert(children.every((event) => event.agentId === `${event.runId}:${event.payload.scopeId}` && event.payload.parentScopeId === "root"));
  const journals = await readJournals(liveProject);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].lines[0].header.schemaVersion, 2);
  const journalUsage = journals[0].lines.flatMap((line) => line.record?.event?.type === "usage" ? [line.record.event] : []);
  const tracedUsage = events.filter((event) => event.payload.tokens);
  assert.equal(tracedUsage.length, journalUsage.length, "every actual request's usage captured once");
  const total = (items, select) => items.reduce((sum, item) => sum + (select(item) ?? 0), 0);
  assert.equal(total(tracedUsage, (event) => event.payload.tokens.input), total(journalUsage, (usage) => usage.promptTokens));
  assert.equal(total(tracedUsage, (event) => event.payload.tokens.cache?.read), total(journalUsage, (usage) => usage.cachedTokens));
  assert(!JSON.stringify(events).includes("scripted private reasoning"));
  const snapshot = await live.get("/snapshot");
  assert(snapshot.graph.nodes.some((node) => node.type === "FILE" && node.label === "output.txt"));
  assert(snapshot.graph.nodes.some((node) => node.type === "AGENT" && node.status === "SUCCEEDED"));
  const edit = events.find((event) => event.kind === "file_edit");
  const replay = await live.get(`/snapshot?seq=${edit.seq - 1}`);
  assert.equal(replay.replay.mode, "seq");
  assert(!replay.graph.appliedEventIds.includes(edit.id));
  const handoff = await live.get("/handoff");
  assert.match(handoff.markdown, /output\.txt/);
  await waitFor(() => live.frames.some((frame) => (frame.events ?? frame.data?.events ?? []).some((event) => event.kind === "session_idle")), "live completion broadcast");
  assert(live.frames.some((frame) => frame.type === "append"), "live WebSocket must deliver incremental appends");
  assert(live.frames.every((frame) => frame.type !== "error"));
  report.scenarios.push({ name: "live CLI/tools/subagent/usage/WS/graph/replay/handoff", events: events.length, requests: journalUsage.length });
  console.log(`PASS live pipeline: ${events.length} events, ${journalUsage.length} requests`);

  const childProject = await project("child-failure");
  const failedChild = await capture(childProject);
  const childRun = await runMotif(childProject, "child-failure", "ABB_PARENT: continue after a child transport failure.");
  assert.equal(childRun.code, 0, childRun.output);
  const childEvents = await completedEvents(failedChild, "session_idle");
  const childGraph = await failedChild.get("/graph");
  assert(childEvents.some((event) => event.kind === "agent_end" && event.payload.success === false));
  assert(childGraph.nodes.some((node) => node.type === "AGENT" && node.status === "FAILED"));
  assert(childGraph.nodes.some((node) => node.type === "SESSION" && node.status === "SUCCEEDED"));
  report.scenarios.push({ name: "failed child does not fail parent", events: childEvents.length });
  console.log("PASS failed child lifecycle");

  const recoveryProject = await project("recovery");
  const recovery = await capture(recoveryProject);
  const unavailable = await runMotif(recoveryProject, "recovery", "ABB_OFFLINE: model unavailable.");
  assert.equal(unavailable.code, 1, unavailable.output);
  const failed = await completedEvents(recovery, "session_error");
  const failedRun = failed.find((event) => event.kind === "session_error").runId;
  recovered = true;
  const restored = await runMotif(recoveryProject, "recovery", "ABB_RESTORED: model is available again.");
  assert.equal(restored.code, 0, restored.output);
  const restoredEvents = await completedEvents(recovery, "session_idle");
  assert(restoredEvents.some((event) => event.kind === "session_idle" && event.runId !== failedRun));
  verifyIdentity(restoredEvents);
  report.scenarios.push({ name: "provider failure then restored connection", runs: new Set(restoredEvents.map((event) => event.runId)).size });
  console.log("PASS provider recovery");

  const restartProject = await project("restart");
  const restart = await capture(restartProject);
  const restartingRun = runMotif(restartProject, "restart", "ABB_RESTART: preserve appended work after recorder restart.");
  await waitFor(() => restartWaiting, "provider paused after first tool");
  await waitFor(async () => (await restart.events()).some((event) => event.kind === "file_read"), "pre-restart read capture");
  await restart.restart();
  restartGate.release();
  const restartedRun = await restartingRun;
  assert.equal(restartedRun.code, 0, restartedRun.output);
  const restartedEvents = await completedEvents(restart, "session_idle");
  verifyIdentity(restartedEvents);
  const restartGraph = await restart.get("/graph");
  assert(restartGraph.nodes.some((node) => node.type === "FILE" && node.label === "after-restart.txt"));
  report.scenarios.push({ name: "recorder restart during active CLI run", events: restartedEvents.length });
  console.log("PASS recorder restart and graph continuity");

  const deliveredBeforeBackfill = restart.deliveries();
  await restart.restart(1);
  await waitFor(() => restart.deliveries() >= deliveredBeforeBackfill + restartedEvents.length, "full journal backfill delivery");
  const backfilledEvents = await restart.events();
  verifyIdentity(backfilledEvents);
  assert.deepEqual(backfilledEvents, restartedEvents, "replaying a captured journal must not duplicate events or usage");
  const backfilledGraph = await restart.get("/graph");
  assert.deepEqual(backfilledGraph.appliedEventIds, restartGraph.appliedEventIds);
  report.scenarios.push({ name: "idempotent backfill into existing daemon store", events: backfilledEvents.length });
  console.log("PASS idempotent journal backfill");

  assert.deepEqual(providerErrors, []);
  for (const captured of [live, failedChild, recovery, restart]) assert.deepEqual(captured.warnings, []);
  await writeFile(join(fixtureRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS ${report.scenarios.length} scenarios against installed Motifcode; no external model requests`);
  if (keep) console.log(`Artifacts: ${fixtureRoot}`);
} catch (error) {
  console.error(`Integration failed: ${error.stack ?? error}`);
  if (providerErrors.length) console.error(providerErrors.join("\n"));
  if (keep) console.error(`Artifacts: ${fixtureRoot}`);
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  if (!keep) await rm(fixtureRoot, { recursive: true, force: true });
}
