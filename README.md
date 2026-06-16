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
  storage/            NDJSON and SQLite persistence
  opencode-adapter/   OpenCode plugin/SDK bridge
```

## Development

```bash
npm install
npm run check
```

Local traces and planning artifacts are ignored by default. The recorder must stay useful without storing raw prompts, secrets, private file contents, or full command output unless the operator explicitly enables local raw capture.

