# Agent-Blackbox

**Open your coding agent's black box.**

<p align="center">
  <img src="https://img.shields.io/github/stars/TaewoooPark/Agent-Blackbox?style=flat-square&logo=github&logoColor=white&labelColor=000000&color=333333" alt="GitHub stars">
  <img src="https://img.shields.io/github/last-commit/TaewoooPark/Agent-Blackbox?style=flat-square&labelColor=000000&color=333333" alt="Last commit">
  <img src="https://img.shields.io/github/languages/top/TaewoooPark/Agent-Blackbox?style=flat-square&labelColor=000000&color=333333" alt="Top language">
  &nbsp;
  <img src="https://img.shields.io/badge/TypeScript-000000?style=flat-square&logo=typescript&logoColor=white&labelColor=000000" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-000000?style=flat-square&logo=react&logoColor=white&labelColor=000000" alt="React">
  <img src="https://img.shields.io/badge/Vite-000000?style=flat-square&logo=vite&logoColor=white&labelColor=000000" alt="Vite">
  <img src="https://img.shields.io/badge/Node.js-000000?style=flat-square&logo=nodedotjs&logoColor=white&labelColor=000000" alt="Node.js">
  <img src="https://img.shields.io/badge/Vitest-000000?style=flat-square&logo=vitest&logoColor=white&labelColor=000000" alt="Vitest">
  &nbsp;
  <img src="https://img.shields.io/badge/OpenCode-000000?style=flat-square&labelColor=000000&color=000000" alt="OpenCode">
  <img src="https://img.shields.io/badge/Local--first-000000?style=flat-square&labelColor=000000&color=000000" alt="Local-first">
  <img src="https://img.shields.io/badge/Live%20stream-000000?style=flat-square&labelColor=000000&color=000000" alt="Live">
</p>

Agent-Blackbox is a **local-first flight recorder for coding agents**. It turns every agent run into a **live, replayable operational graph** — what the agent read, changed, ran, decided, delegated, blocked on, and verified — reconstructed from observed events, not from the agent's own summary.

> *"The transcript is what the agent said. The black box is what it did."*

[**taewoopark.com** — author site](https://taewoopark.com)

<p align="center">
  <img src="./docs/screenshots/session-map.jpeg" alt="Agent-Blackbox session map — a complex OpenCode run ('Real-time 3D universe engine') rendered as a Mark Lombardi narrative structure: each moment is a hollow ring with a serif label, the trunk and five dotted subagent branches (explore, shader-engineer, physics-engineer, test-runner, docs-writer) join ring-to-ring, and thin sweeping arcs connect each node to the files it touched. Monochrome graphite on paper, with failed tests in oxblood. The right rail shows a 70 context-efficiency score with optimization notations." width="100%">
</p>

---

## Why Agent-Blackbox?

You hand a task to a coding agent. It reads a dozen files, runs commands, edits code, sometimes spawns subagents, and hands you back a tidy summary. Today your only window into that work is a scrolling terminal transcript — and a summary you have to take on faith.

Agent-Blackbox replaces that with a structured, evidence-backed record you can actually inspect.

| Reading the transcript | Agent-Blackbox |
|---|---|
| Scroll a linear log | A **session map** you read at a glance |
| Trust the agent's summary | Reconstructed from **observed events** |
| "It passed the tests" | See the test **fail (red) → fix → pass (green)** |
| Lose the thread on long runs | **Scrub and replay** any moment in time |
| One opaque agent | **Subagent genealogy** — who delegated what |
| Re-read everything to resume | One-click **handoff** summary |
| Your code & prompts leave the machine | **Local-first**, minimal capture by default |

---

## Watch it happen — live

The map is not a post-mortem. It is built **as the agent works**: the recorder streams events to a local daemon, and the dashboard updates over a WebSocket — moments appear, files connect, tokens tick, a failure flashes red, the fix turns it green. No refresh, no replay required.

That is the whole idea: **open the black box while the flight is still in the air.**

---

## Philosophy — observe, don't trust the narrator

The gap between what an agent *says* and what it *does* is where bugs, overconfidence, and unverified claims live. Agent-Blackbox is built on one principle:

> **Derive the truth from observed events, never from free-form self-report.**

- **Behavior, not narration.** Every node on the map is an event the agent actually emitted — a read, an edit, a command and its exit code, a delegation — not a sentence it wrote about itself.
- **A flight recorder, not a chat log.** When an agent takes consequential actions on real code, you want a faithful, replayable record that is independent of the pilot's account.
- **Local-first by default.** Traces stay on your machine. Raw prompts, secrets, and private file contents are redacted unless you explicitly opt in.
- **Host-agnostic core.** A canonical event + graph core with thin host adapters, so the same black box can sit behind any agent harness — OpenCode is the first.

---

## Features

```
   ┌──────────────┬─────────────────────────────────┬──────────────┐
   │ agent lanes  │          session map            │  file panel  │
   │ + tokens     │   (live operational graph)      │ (top-right)  │
   │ + timeline   │   read → edit → fail → fix → ✓   │              │
   └──────────────┴─────────────────────────────────┴──────────────┘
```

- **Live session map** — the run forms in real time as a spine of meaningful moments; consecutive repeats aggregate (`Created 12 files`, `Tests passed ×6`) so even large runs stay scannable.
- **Narrative-structure aesthetic** — a flat, monochrome "Mark Lombardi" diagram: hollow ring nodes, sweeping ring-to-ring arcs, serif labels. Pure graphite on paper (light) or silverpoint on ink (dark); the lone accent is **oxblood, used only for risk/failure**.
- **Replay** — drag the navigation-chart timeline to any sequence point; the graph and files reflect state at exactly that moment.
- **Click to focus** — select any moment for a detail popover (evidence, files, tokens); click a file to highlight every moment that touched it, with the connection arcs drawn from each node's ring.
- **Subagent genealogy** — real delegations (the `task` tool / child sessions) fork into their own branch, attributed to the subagent that did the work.
- **Handoff export** — generate a structured continuation summary (objective, files in play, decisions, commands, failures, blockers, next safe action) and copy it as Markdown.
- **Run picker** — one project log can hold many runs; the console follows the most recently *active* run and lets you pin any past one.
- **Context efficiency** — a live score for how economically the run used its context window (cache reuse, redundant re-reads, read-vs-edit amplification, oversized tool outputs, retry waste, yield density), with one-tap optimization suggestions — rule-based by default, or routed to a **free/local model** (no API key).
- **One-command bootstrap** — `npm run up` installs the recorder plugin, starts the daemon, and serves the dashboard.

<p align="center">
  <img src="./docs/screenshots/features.jpeg" alt="Four-panel overview of Agent-Blackbox. Top-left: the live session map of a multi-agent run as a monochrome Lombardi network of rings and sweeping arcs. Top-right: the same console in dark mode (silverpoint on ink). Bottom-left: the context-efficiency co-pilot — a score, segmented metric meters, and optimization notations. Bottom-right: the handoff export panel." width="100%">
</p>

---

## How it works

```
 opencode run ──hooks──▶  recorder plugin  ──events──▶   daemon   ──/stream──▶  dashboard
                          redact + normalize            NDJSON log            live session map
                          (host adapter)                + graph/replay        (this UI)
```

- **`packages/core`** — canonical `TraceEvent`s, the workflow graph model, redaction, replay, audit, and handoff generation.
- **`packages/opencode-adapter`** — a thin OpenCode plugin that turns host events and tool calls into canonical, redacted events and ships them to the daemon (best-effort, with retries).
- **`apps/daemon`** — ingests events to a local NDJSON log, materializes the graph, replays it to any point, and pushes live snapshots over WebSocket.
- **`apps/dashboard`** — the operator console that renders the live session map, replay, inspector, and handoff.

---

## Quickstart

```bash
npm install
npm run build

# One command: install the recorder plugin, start the daemon, serve the dashboard
npm run up -- --project /path/to/your/project
```

Then run your agent inside that project (the `up` output prints the exact line):

```bash
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 \
  opencode run --dir /path/to/your/project \
  "Read the relevant code, run the tests, and summarize the result."
```

Open the dashboard URL it printed (default `http://127.0.0.1:5173/`) and watch the run assemble itself live. When you need to continue the run elsewhere — a teammate, the next agent, or the same agent after a context reset — export a structured **handoff**:

<p align="center">
  <img src="./docs/screenshots/handoff.jpeg" alt="Agent-Blackbox handoff summary — a solid paper card over the dimmed session map listing the run's objective, what was observed (events, nodes, edges), files in play, decisions, commands / verification, blockers, and the next safe action, with a one-click Copy markdown button." width="100%">
</p>

---

## Context efficiency

The **CONTEXT** panel scores how economically each run used its context window — derived from observed sizes and token snapshots, never the agent's self-report. Flagged metrics get one-tap, concrete optimization tips.

Suggestions are **rule-based by default** (always available, no dependencies). To get them tailored by a model — with **no API key** — point `up` at a local/free model:

```bash
# Ollama (recommended): no key, runs locally
npm run up -- --project /path/to/project --suggest ollama --suggest-model llama3.1

# Any OpenAI-compatible localhost server (LM Studio, llama.cpp)
npm run up -- --project /path --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# Reuse OpenCode's free model via your installed binary
npm run up -- --project /path --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
```

`--suggest auto` (the default) probes those in order and falls back to rule-based. Only a **redacted, derived digest** (statuses, counts, sizes — never file contents, paths, or commands) is ever sent, even to a local model.

---

## Daemon API

| Method & path | Purpose |
|---|---|
| `POST /events` | Ingest a canonical `TraceEvent` |
| `GET /events` | The durable event log |
| `GET /graph?seq=<n>` | Replay the graph up to a sequence |
| `GET /snapshot?seq=<n>` | Events, graph, audit checks, efficiency report, and handoff markdown |
| `GET /audit` | Promise / claim checks |
| `GET /efficiency?seq=<n>` | Context-efficiency report (scores + metrics) |
| `POST /suggest` | Optimization suggestions for a posted report (deterministic or local-model) |
| `GET /handoff` | Generated handoff markdown |
| `WS /stream` | Live snapshots pushed after each ingest |

---

## Project layout

```text
apps/
  daemon/             local ingest, replay, static dashboard, and websocket daemon
  dashboard/          operator console (live session map, replay, inspector, handoff)
packages/
  core/               canonical events, graph model, redaction, replay, audit, handoff
  storage/            NDJSON persistence
  opencode-adapter/   OpenCode plugin / SDK bridge
```

## Development

```bash
npm install
npm run check   # typecheck + tests
npm run build
```

---

## Roadmap

- More host adapters beyond OpenCode (PI, Claude Code, and other harnesses) on the same canonical core.
- Deeper audit: claim-vs-evidence verification and risky-command surfacing.
- Richer multi-agent fleets and cross-run views.

---

<p align="center"><sub>Local-first. Observe, don't trust the narrator.</sub></p>
