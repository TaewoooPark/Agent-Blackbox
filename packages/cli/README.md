# Agent-Blackbox

**Open your coding agent's black box.**

A **local-first flight recorder and context-efficiency profiler** for **[Claude Code](https://www.claude.com/product/claude-code)** and **[OpenCode](https://opencode.ai)**. It turns every agent run into a **live, replayable map** of what the agent actually *did* — what it read, changed, ran, decided, delegated, blocked on, and verified — reconstructed from observed events, not from the agent's own summary. Then it **scores how economically the run used its context window** and tells you, concretely, how to make the next one cheaper and faster.

Everything runs on your machine. **No API key. Nothing leaves your computer.**

<p align="center">
  <img src="https://raw.githubusercontent.com/TaewoooPark/Agent-Blackbox/main/docs/screenshots/session-map.jpeg" alt="Agent-Blackbox session map — a real multi-agent run rendered as a monochrome Mark Lombardi network of hollow rings and sweeping arcs, with a context-efficiency score on the right." width="100%">
</p>

> *"The transcript is what the agent said. The black box is what it did — and what it cost."*

## Quickstart

One command (needs Node 20+):

```bash
# Record Claude Code — nothing to install; the daemon tails the session
# transcripts it already writes (~/.claude/projects/)
npx @taewooopark/agent-blackbox up --host claude-code

# …or record OpenCode (installs the recorder into OpenCode's global plugin dir)
npx @taewooopark/agent-blackbox up

# …or record both hosts at once, into one dashboard
npx @taewooopark/agent-blackbox up --host all
```

It starts a local daemon and **opens the dashboard** at `http://127.0.0.1:5173/`. Now use your agent exactly the way you already do — the map fills in live:

```bash
claude            # Claude Code, in any folder — zero setup, just run it
opencode          # …or OpenCode (terminal or the desktop app)
```

Stop recording any time with `npx @taewooopark/agent-blackbox uninstall`.

## Why

You can't just **ask** an agent what a task cost. A 2026 study of eight frontier models on agentic coding found they predict their own token usage with a correlation of just **0.39 — and systematically underestimate** the bill; the same task varies **up to 30×** in tokens, and agentic runs burn **~1000× more tokens** than ordinary coding. So don't ask — **measure.**

<sub>Bai et al., *How Do AI Agents Spend Your Money?*, [arXiv:2604.22750](https://arxiv.org/abs/2604.22750) (2026).</sub>

## What you get

| Feature | What it does |
|---|---|
| **Live session map** | the run forms in real time — reads, edits, commands, subagents, decisions — over a WebSocket, no refresh |
| **Replay** | scrub the timeline to any moment; the graph and files rewind to that exact point |
| **Subagent genealogy** | real delegations fork into their own lane, attributed to the subagent that did the work |
| **Context-efficiency score** | cache reuse, redundant re-reads, read-vs-edit amplification, oversized tool dumps, retry waste — with reclaimable tokens |
| **Concrete fixes** | rule-based by default, or tailored by a **free/local model with no API key** — and optionally written back to `AGENTS.md` so the next run avoids the waste |
| **Handoff export** | one-click Markdown summary (objective, files, decisions, blockers, next step) to resume elsewhere |
| **Local-first** | traces stay on your machine; prompts, secrets, and file contents are redacted by default |

<p align="center">
  <img src="https://raw.githubusercontent.com/TaewoooPark/Agent-Blackbox/main/docs/screenshots/features.jpeg" alt="Four-panel overview: the live session map, the same console in dark mode, the context-efficiency co-pilot with metric meters, and the handoff export panel." width="100%">
</p>

## Hosts

- **Claude Code** — **no install at all.** The daemon tails the JSONL transcripts the CLI already writes, so any folder, any session is recorded the moment you run `claude`. Add `--optimize` to also install the opt-in in-run actuator hooks.
- **OpenCode** — records via a recorder dropped into OpenCode's **global** plugin directory (`~/.config/opencode/plugins/`), so any session is captured, the desktop app included. Scope to one project with `up --project <dir>`.

## Common flags

```bash
up --host claude-code|opencode|all   # which agent(s) to record (default: opencode)
up --suggest free                    # tailored fixes from a rotating pool of free models
up --port 48000 --ui-port 4000       # custom daemon / dashboard ports
up --no-open                         # don't auto-open the browser
uninstall                            # remove the global recorder (+ any Claude Code hooks)
```

## Documentation

Full docs, screenshots, architecture, and the optimization actuator:
**https://github.com/TaewoooPark/Agent-Blackbox**

📊 **[Scoring & analysis reference](https://github.com/TaewoooPark/Agent-Blackbox/blob/main/docs/analysis.md)** — every metric + threshold, the task archetypes, the effectiveness axis, the `rules.json` schema, and the honest known-limitations.

[English](https://github.com/TaewoooPark/Agent-Blackbox/blob/main/README.md) ·
[한국어](https://github.com/TaewoooPark/Agent-Blackbox/blob/main/README.ko.md) ·
[中文](https://github.com/TaewoooPark/Agent-Blackbox/blob/main/README.zh.md) ·
[日本語](https://github.com/TaewoooPark/Agent-Blackbox/blob/main/README.ja.md)

## License

MIT © [Taewoo Park](https://taewoopark.com)
