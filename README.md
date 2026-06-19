# Agent-Blackbox

**Open your coding agent's black box.**

<p align="center">
  <b>English</b> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.zh.md">中文</a> ·
  <a href="./README.ja.md">日本語</a>
</p>

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
  <img src="https://img.shields.io/badge/No%20API%20key-000000?style=flat-square&labelColor=000000&color=000000" alt="No API key">
  <img src="https://img.shields.io/badge/Live%20stream-000000?style=flat-square&labelColor=000000&color=000000" alt="Live">
</p>

Agent-Blackbox is a **local-first flight recorder and context-efficiency profiler for coding agents.** It turns every agent run into a **live, replayable operational graph** — what the agent read, changed, ran, decided, delegated, blocked on, and verified — reconstructed from observed events, not from the agent's own summary. Then it **measures how economically that run used its context window** and tells you, concretely, how to make the next one cheaper and faster.

> *"The transcript is what the agent said. The black box is what it did — and what it cost."*

[**taewoopark.com** — author site](https://taewoopark.com)

<p align="center">
  <img src="./docs/screenshots/session-map.jpeg" alt="Agent-Blackbox session map — a complex OpenCode run ('Real-time 3D universe engine') rendered as a Mark Lombardi narrative structure: each moment is a hollow ring with a serif label, the trunk and five dotted subagent branches (explore, shader-engineer, physics-engineer, test-runner, docs-writer) join ring-to-ring, and thin sweeping arcs connect each node to the files it touched. Monochrome graphite on paper, with failed tests in oxblood. The right rail shows a 70 context-efficiency score with optimization notations." width="100%">
</p>

---

## Two things at once

**1 · See what the agent actually did.** A coding agent reads a dozen files, runs commands, edits code, spawns subagents, and hands you back a tidy summary. Your only window into that is a scrolling transcript and a summary you take on faith. Agent-Blackbox replaces it with a structured, evidence-backed **session map** you read at a glance.

**2 · See — and shrink — what it cost.** Context is money, latency, and a hard window limit. Agent-Blackbox scores how economically each run used its context (cache reuse, redundant re-reads, read-vs-edit amplification, oversized tool dumps, retry waste) and surfaces **specific optimizations** — rule-based by default, or tailored by a **free, local model with no API key**.

| Reading the transcript | Agent-Blackbox |
|---|---|
| Scroll a linear log | A **session map** you read at a glance |
| Trust the agent's summary | Reconstructed from **observed events** |
| "It passed the tests" | See the **fail → fix → pass** loop |
| Lose the thread on long runs | **Scrub and replay** any moment in time |
| One opaque agent | **Subagent genealogy** — who delegated what |
| No idea what it cost | A **context-efficiency score** + reclaimable tokens |
| "Why is this run so expensive?" | **Concrete fixes**, optionally written by a local model |
| Re-read everything to resume | One-click **handoff** summary |
| Your code & prompts leave the machine | **Local-first**, minimal capture, **no API key** |

---

## Watch it happen — live

The map is not a post-mortem. It is built **as the agent works**: the recorder streams events to a local daemon, and the dashboard updates over a WebSocket — moments appear, files connect by sweeping arcs, tokens tick, a failed test marks oxblood, the fix resolves it. No refresh, no replay required.

That is the whole idea: **open the black box while the flight is still in the air.**

---

## What you get

- **Live session map** — the run forms in real time as a spine of meaningful moments; consecutive repeats aggregate (`Created 12 files`, `Tests passed ×6`) so even large runs stay scannable.
- **Narrative-structure aesthetic** — a flat, monochrome "Mark Lombardi" diagram: hollow ring nodes, sweeping ring-to-ring arcs, serif labels. Graphite on paper (light) or silverpoint on ink (dark); the lone accent is **oxblood, used only for risk/failure**.
- **Replay** — drag the navigation-chart timeline to any sequence point; the graph and files reflect state at exactly that moment.
- **Click to focus** — select any moment for a detail popover (evidence, files, tokens); select an agent to isolate its lane; click a file to highlight every moment that touched it, with arcs drawn from each node's ring.
- **Subagent genealogy** — real delegations (the `task` tool / child sessions) fork into their own branch, attributed to the subagent that did the work.
- **Context efficiency** — a live score + metric meters (context pressure, cache hit, redundant reads, read amplification, large injections, retry waste, yield density) with one-tap optimization notations — **rule-based, or tailored by a free model with no API key**. `--suggest free` rotates a pool of free models across independent quotas (OpenCode Zen + Ollama cloud + local), failing over and cooling down on rate limits, so the AI suggestions stay free and durable over long sessions.
- **Handoff export** — a structured continuation summary (objective, files in play, decisions, commands, failures, blockers, next safe action), one click to copy as Markdown.
- **Run picker** — one project log can hold many runs; the console follows the most recently *active* run and lets you pin any past one.
- **Full event coverage** — whichever model you run, every action is captured (reads, edits, bash, skills, custom/MCP tools, permissions, todos, subagents, **slash commands, `/compact` context compaction, agent/model switches**) — keyed off the host event, never the model. Known noise (LSP, pty, file-watcher, MCP registry) is filtered; anything not yet modeled still surfaces as a labeled node, so nothing is silently dropped.
- **One-command bootstrap** — `npm run up` installs the recorder plugin, starts the daemon, and serves the dashboard.

<p align="center">
  <img src="./docs/screenshots/features.jpeg" alt="Four-panel overview of Agent-Blackbox. Top-left: the live session map of a multi-agent run as a monochrome Lombardi network of rings and sweeping arcs. Top-right: the same console in dark mode (silverpoint on ink). Bottom-left: the context-efficiency co-pilot — a score, segmented metric meters, and optimization notations. Bottom-right: the handoff export panel." width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/focus.jpeg" alt="Two-panel view of focusing. Left: clicking a moment dims the map to that node and opens a detail popover below it (evidence, files, tokens, replay). Right: selecting an agent isolates its lane — that agent's branch and moments stay lit while the rest of the diagram recedes." width="100%">
</p>

<p align="center">
  <img src="./docs/screenshots/replay.jpeg" alt="Two-panel view. Left: replay — the timeline scrubbed to mid-run, the diagram rewound to that sequence point as five subagents fan out from the prompt. Right: the context-efficiency co-pilot after Optimize with a local model, showing tailored notations (Stabilize prompt prefix, Deduplicate file reads) generated by a local Ollama model with no API key." width="100%">
</p>

---

## Context efficiency — the part that pays for itself

Every run gets a score from observed sizes and token snapshots — never the agent's self-report. Each flagged metric expands into a concrete fix.

| Metric | What it catches |
|---|---|
| **Context pressure** | how large the prompt grew at its peak |
| **Cache hit ratio** | how much of the prompt was served from cache |
| **Redundant re-reads** | the same file pulled in more than once (with reclaimable tokens) |
| **Read amplification** | reading far more than was edited — read the slice, not the file |
| **Large injections** | a single tool output flooding the window |
| **Retry waste** | failing commands re-run before the cause was fixed |
| **Yield density** | how much concrete change each 1k tokens produced |

Suggestions are **rule-based by default** (always on, no dependencies). To have them tailored by a model — with **no API key** — point `up` at a local/free model:

```bash
# Free, durable, default: rotate a pool of free models across independent quotas
npm run up -- --project /path --suggest free

# Ollama: local, no key
npm run up -- --project /path --suggest ollama --suggest-model qwen2.5-coder

# Any OpenAI-compatible localhost server (LM Studio, llama.cpp)
npm run up -- --project /path --suggest openai-compat --suggest-base-url http://127.0.0.1:1234

# Reuse OpenCode's free model via your installed binary
npm run up -- --project /path --suggest opencode --suggest-model opencode/deepseek-v4-flash-free
```

**`--suggest free`** (and the default `auto`) rotate a curated pool of **free** models across **independent quota pools** — OpenCode Zen (`opencode/*-free`) + Ollama cloud + a local model — one model per call, rotated to spread load, **failing over and cooling down a model that hits a rate limit (429)** for 10 minutes, and falling back to rule-based only if every pool is exhausted. So the AI suggestions stay free and keep working over long sessions without you babysitting a single quota. Only a **redacted, derived digest** is ever sent, even to a local model: metric statuses, counts, and sizes, plus coarse **offender labels — file basenames and command verbs** (e.g. `billing.ts ×2`, `deploy ×2`) so the advice can name what to fix — but **never file contents, directory paths, command arguments, prompts, or secrets**.

### What the advice is built on

The suggestions aren't generic tips. Both the always-on rule-based floor and the local-model prompt encode a per-metric **fix playbook**, and every action is required to cite the run's own numbers, name the offending file/command, state a concrete mechanism, and give the expected effect. The playbook is distilled from published context-engineering research and production practice:

| Source | What it contributes | Metrics it informs |
|---|---|---|
| Anthropic — [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | **Compaction** (summarize resolved turns → fresh window), clearing tool outputs already acted on, **sub-agent context isolation** (explore in a child that returns a ~1–2k-token summary), and **just-in-time retrieval** (grep/glob, read on demand instead of pre-loading whole files) | `context-pressure`, `read-amplification`, `redundant-reads`, `yield-density` |
| Manus — [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | **KV-cache hit rate** as the primary cost lever (cached tokens ≈ 10× cheaper), a byte-stable prompt prefix (no timestamps/volatile data), append-only context, masking tools instead of adding/removing them, the file system as external memory, and **recitation** of the goal each step | `cache-hit`, `large-injections`, `retry-waste` |
| Liu et al. — [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) | Models systematically **under-use the middle** of long contexts (U-shaped accuracy, ~30%+ degradation) — so advice favors trimming/repositioning and goal recitation over "add more context" | `context-pressure`, `yield-density` |
| Anthropic — [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Minimal, **non-overlapping tool sets** and unambiguous tool boundaries; batch related actions instead of exploratory call chains | `tool-overhead` |
| Schulhoff et al. — [The Prompt Report: A Systematic Survey of Prompt Engineering Techniques](https://arxiv.org/abs/2406.06608) | Contrastive few-shot exemplars (a bad-vague vs good-specific pair), grounding answers in the provided numbers, and strict structured output — so even small local models return specific, actionable JSON | *(shapes the advisor prompt itself)* |

Verified end-to-end on a small local model: a redundant-reads finding turns from "read each file once" into **"`calculator.js` was read 2× (~282 reclaimable) — read it once and cache it, then after each edit re-read only the changed line range instead of the whole file."**

### Close the loop — write the fix back *(experimental)*

Advice you have to re-apply by hand is friction. `optimize` turns the last run's findings into a small, **cache-safe** memory block in your project's `AGENTS.md` — the file the agent already reads as context — so the *next* run avoids the waste before it happens. It's the actuator half of the recorder: observe → diagnose → **write → measure → roll back if it didn't help.**

```bash
# Preview what it would write (no changes)
npm run optimize -- --project ~/code/my-app

# Apply: append a managed block to AGENTS.md + record the baseline score
npm run optimize -- --project ~/code/my-app --apply

# After the next run, confirm it helped — auto-rolls-back on a clear score drop
npm run optimize -- --project ~/code/my-app --check

# Undo at any time
npm run optimize -- --project ~/code/my-app --revert
```

The block is written **between markers at the end of the file**, so the stable prompt-cache prefix is never disturbed. It names the concrete offenders (files to read once, large outputs to scope, verified build/test commands to reuse) and is fully reversible — every write is marked, opt-in, and never silent.

#### Measured on a real run

A controlled before/after on a real OpenCode run (small JS repo, local `llama3.1:8b`). Run A summarized three files and re-read one; Agent-Blackbox flagged the re-read and pinned *"read `calculator.js` once"* to `AGENTS.md`. Run B — **same task, memory in place** — read each file once:

| | Before (run A) | After (run B) |
|---|---|---|
| Context-efficiency score | 77 | **87** |
| Peak input | 28k | **17k** |
| File reads | 4 (`calculator.js` ×2) | **3** (no re-read) |
| Redundant re-reads | 1 file (~110 reclaimable) | **none** |
| Tool overhead | 2.0× | **1.0×** |
| Tokens | 29k | **17k** |

<table>
<tr>
<td width="50%"><img src="./docs/screenshots/optimize-before.jpeg" alt="Before: context-efficiency panel scoring 77, flagging 'Redundant re-reads — calculator.js ×2 were re-read (~110 reclaimable)', context pressure 28k, tool overhead 2.0×, 29k tokens." width="100%"></td>
<td width="50%"><img src="./docs/screenshots/optimize-after.jpeg" alt="After: the same panel scoring 87 with 'Redundant re-reads: none', context pressure down to 17k, tool overhead 1.0×, 17k tokens." width="100%"></td>
</tr>
</table>

> ⚠️ **This `--check` two-run cycle is a benchmark to *validate the mechanism* — not the production workflow.** Re-running the same task to measure would spend tokens twice. In real use you apply once and the memory pays off on *future, different* tasks in that repo (reused commands, files to read once) with **no extra run**.

### In-run optimizer — cut the waste live, no re-run *(opt-in)*

The AGENTS.md memory above pays off on *future* tasks. The in-run optimizer cuts waste **inside the current run** — the recorder stops being purely passive and serves re-reads cheaply through the OpenCode tool hooks. Enable it with `AGENT_BLACKBOX_OPTIMIZE=1` (or `--optimize` at install); off by default.

- **Re-reads served as a no-op or a diff.** When the agent re-reads a file it already read this run, the `tool.execute.after` hook rewrites the result: *unchanged* → a one-line "reuse your earlier copy" note; *edited* → only the changed line range. Measured on a 120-line file: **96% fewer tokens on an unchanged re-read, 94% on an edited one** — in the same run, zero re-run.
- **Correct by construction.** Re-reads are never blocked (you might genuinely need one). The no-op/diff only fires when **no compaction has happened since** the file was last served — so the content is provably still in context. After a compaction the full file is served again, because the agent may have lost it.
- **Working-set memory injected live.** Via `experimental.chat.system.transform`, a tiny always-current block (hot files + verified commands, derived from observed events) is appended to the system prompt, so the agent recalls instead of re-reading.

#### What's next

- **Longitudinal trend** — Agent-Blackbox records every run; chart the efficiency score across your *real* runs and show whether it rises after the memory + optimizer land — measurement from actual work, not a benchmark.
- **Diff-serving across compaction** — keep a small local content cache so even post-compaction re-reads can be served as diffs (today they fall back to full).

---

## Pairs with oh-my-openagent — profile and shrink heavy multi-agent runs

[**oh-my-openagent (OMO)**](https://github.com/code-yeongyu/oh-my-openagent) turns OpenCode into a multi-agent *tokenmaxxer* harness — 11 specialists, parallel execution, a relentless loop that spends tokens hard to ship complex work. Agent-Blackbox is the instrument built for exactly that workload: **OMO floors the accelerator; Agent-Blackbox is the dyno and the telemetry.**

They're both OpenCode plugins and coexist with zero config — run OMO with the recorder installed and the whole team shows up:

- **See the whole team.** Every SDK-spawned subagent (Sisyphus, explore, librarian, plan, oracle…) gets its own lane; delegation forks the trunk; files connect by sweeping arcs. The map was built for runs this complex.
- **See — and shrink — the cost.** A "tokenmaxxer" run is exactly where context economy matters most. Agent-Blackbox scores it (context pressure, redundant re-reads, read amplification, tool overhead) and names the precise offenders — the cost you can't see from inside the harness.
- **Close the loop.** Pin the findings to `AGENTS.md` for the next run, and turn on the in-run optimizer (`AGENT_BLACKBOX_OPTIMIZE=1`) to serve a re-read as a no-op/diff — savings inside the *same* run, no re-run.

A real OMO `ultrawork` run, recorded live by Agent-Blackbox — named specialist lanes on the left, and a context-efficiency score with reclaimable tokens and tailored fixes on the right:

<p align="center">
  <img src="./docs/screenshots/omo-synergy.jpeg" alt="Agent-Blackbox profiling a real oh-my-openagent ultrawork session: the left rail lists named specialist lanes (Sisyphus, explore, librarian, plan), the center session map forks the trunk into subagent branches with files connected by arcs, and the right rail shows a context-efficiency score, peak context, tool overhead, and tailored optimization suggestions." width="100%">
</p>

```bash
# OMO installs globally; Agent-Blackbox records the project. Run OMO, watch :5173.
npm run up -- --project ~/code/my-app --suggest free
opencode run "ultrawork: refactor the auth module and add tests"   # OMO + recorder both active
```

---

## Quickstart

**Fastest — no clone, no build** (needs Node 20+ and [OpenCode](https://opencode.ai)):

```bash
npx @taewooopark/agent-blackbox up --project /path/to/your/project
```

That one command fetches the recorder + dashboard, installs the recorder plugin into your project, starts the daemon, and **opens the dashboard in your browser** (`http://127.0.0.1:5173/`; add `--no-open` to skip). Then run your agent inside that project (the command's output prints the exact line):

<details>
<summary><b>Or run from source</b> (development / contributing)</summary>

```bash
git clone https://github.com/TaewoooPark/Agent-Blackbox
cd Agent-Blackbox && npm install
npm start -- --project /path/to/your/project
```
</details>

```bash
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 \
  opencode run --dir /path/to/your/project \
  "Read the relevant code, run the tests, and summarize the result."
```

The map assembles itself live. That's it.

### Recipes

```bash
# Just watch a run — point it at any project and go
npm run up -- --project ~/code/my-app

# Optimize: run something heavy, then read the context score + fixes in the right rail
npm run up -- --project ~/code/my-app --suggest ollama --suggest-model qwen2.5-coder

# Multi-agent: delegate, and watch each subagent fork into its own lane
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 opencode run --dir ~/code/my-app \
  "Delegate exploration, implementation, and tests to subagents, then summarize."

# Resume elsewhere: open the run, click Handoff, copy the Markdown into the next session

# Pick a different port if 47831/5173 are taken
npm run up -- --project ~/code/my-app --port 48000 --ui-port 4000
```

When you need to continue the run elsewhere — a teammate, the next agent, or the same agent after a context reset — export a structured **handoff**:

<p align="center">
  <img src="./docs/screenshots/handoff.jpeg" alt="Agent-Blackbox handoff summary — a solid paper card over the dimmed session map listing the run's objective, what was observed (events, nodes, edges), files in play, decisions, commands / verification, blockers, and the next safe action, with a one-click Copy markdown button." width="100%">
</p>

---

## How it works

```
 opencode run ──hooks──▶  recorder plugin  ──events──▶   daemon   ──/stream──▶  dashboard
                          redact + normalize            NDJSON log            live session map
                          (host adapter)                + graph/replay        + efficiency
                                                        + efficiency report   (this UI)
```

- **`packages/core`** — canonical `TraceEvent`s, the workflow graph model, redaction, replay, audit, handoff generation, and the context-efficiency engine.
- **`packages/opencode-adapter`** — a thin OpenCode plugin that turns host events and tool calls into canonical, redacted events (with content *sizes*, never content) and ships them to the daemon, best-effort with retries.
- **`apps/daemon`** — ingests events to a local NDJSON log, materializes the graph, replays it to any point, computes the efficiency report, routes suggestions, and pushes live snapshots over WebSocket.
- **`apps/dashboard`** — the operator console: live session map, replay, inspector, efficiency co-pilot, and handoff.

---

## Philosophy — observe, don't trust the narrator

> **Derive the truth from observed events, never from free-form self-report.**

- **Behavior, not narration.** Every node is an event the agent actually emitted — a read, an edit, a command and its exit code, a delegation — not a sentence it wrote about itself.
- **Cost is evidence too.** The efficiency score and every suggestion come from observed sizes and token snapshots, not from the model's account of its own thrift.
- **Local-first, no key.** Traces stay on your machine. Raw prompts, secrets, and file contents are redacted by default; even the optional model suggestions run locally and receive only a redacted digest.
- **Host-agnostic core.** A canonical event + graph core with thin host adapters, so the same black box can sit behind any agent harness — OpenCode is the first.

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
  daemon/             local ingest, replay, efficiency, suggestion routing, static dashboard, websocket
  dashboard/          operator console (session map, replay, inspector, efficiency, handoff)
packages/
  core/               canonical events, graph model, redaction, replay, audit, handoff, efficiency
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

- More host adapters beyond OpenCode (Claude Code, PI, and other harnesses) on the same canonical core.
- Deeper audit: claim-vs-evidence verification and risky-command surfacing.
- Cross-run efficiency trends and fleet-wide views.

---

## Contact

<p align="center">
  <a href="https://github.com/TaewoooPark"><img src="https://img.shields.io/badge/-GitHub-181717?style=for-the-badge&logo=github&logoColor=white&cacheSeconds=3600" alt="GitHub"></a>
  <a href="https://x.com/theoverstrcture"><img src="https://img.shields.io/badge/-X-000000?style=for-the-badge&logo=x&logoColor=white&cacheSeconds=3600" alt="X (Twitter)"></a>
  <a href="https://www.linkedin.com/in/taewoo-park-427a05352"><img src="https://img.shields.io/badge/-LinkedIn-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white&cacheSeconds=3600" alt="LinkedIn"></a>
  <a href="https://www.instagram.com/t.wo0_x/"><img src="https://img.shields.io/badge/-Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white&cacheSeconds=3600" alt="Instagram"></a>
  <a href="https://taewoopark.com"><img src="https://img.shields.io/badge/-taewoopark.com-000000?style=for-the-badge&logo=safari&logoColor=white&cacheSeconds=3600" alt="Personal site"></a>
  <a href="mailto:ptw151125@kaist.ac.kr"><img src="https://img.shields.io/badge/-Email-D14836?style=for-the-badge&logo=gmail&logoColor=white&cacheSeconds=3600" alt="Email"></a>
</p>

<p align="center"><sub>Local-first. No API key. Observe, don't trust the narrator.</sub></p>
