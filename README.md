# Agent-Blackbox

Local-first workflow recorder for coding agents.

Agent-Blackbox turns agent execution into a replayable operational graph: what each agent read, changed, ran, decided, delegated, blocked on, and verified.

This repository is intentionally scaffolded around a host-agnostic core plus thin host adapters. OpenCode is the first target adapter; PI and other harnesses come later.

## Packages

```text
apps/
  daemon/             local ingest, replay, and websocket daemon
  dashboard/          operator console
packages/
  core/               canonical events, graph model, redaction, replay
  storage/            NDJSON persistence
  opencode-adapter/   OpenCode plugin/SDK bridge
```

## OpenCode MVP Quickstart

Build the workspace:

```bash
npm install
npm run build
```

Start the local trace daemon for the project you want to observe:

```bash
node apps/daemon/dist/cli.js daemon --project /path/to/project --port 47831
```

Install the project-local OpenCode recorder plugin:

```bash
node apps/daemon/dist/cli.js init-opencode \
  --project /path/to/project \
  --adapter-package file:/absolute/path/to/Agent-Blackbox/packages/opencode-adapter \
  --daemon-url http://127.0.0.1:47831
```

Then run OpenCode in that project:

```bash
AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 \
AGENT_BLACKBOX_RUN_ID=my-run-id \
opencode run --dir /path/to/project "Read the relevant file, run tests, and summarize the result."
```

Start the dashboard:

```bash
VITE_AGENT_BLACKBOX_DAEMON_URL=http://127.0.0.1:47831 \
npm run dev --workspace @agent-blackbox/dashboard -- --port 5173
```

Open `http://127.0.0.1:5173/`. The dashboard reads daemon snapshots, receives live updates over `/stream`, can scrub replay by event sequence, shows evidence-linked file/command nodes, evaluates simple model promise checks, and exports a handoff summary.

## Daemon API

- `POST /events` accepts canonical `TraceEvent` JSON.
- `GET /events` returns the durable event log.
- `GET /graph?seq=<n>` replays the graph up to a sequence.
- `GET /snapshot?seq=<n>` returns events, graph, audit checks, and handoff markdown.
- `GET /audit` returns promise checks.
- `GET /handoff` returns generated handoff markdown.
- `WS /stream` pushes live snapshots after event ingest.

## Development

```bash
npm install
npm run check
npm run build
```

Local traces and planning artifacts are ignored by default. The recorder must stay useful without storing raw prompts, secrets, private file contents, or full command output unless the operator explicitly enables local raw capture.

Current OpenCode normalization promotes completed `read` tools into `file_read` events and completed `bash` tools into `bash` events with exit codes and short output previews. PI, SQLite, and deeper multi-agent harness instrumentation are planned adapters/layers, not part of the current MVP.
