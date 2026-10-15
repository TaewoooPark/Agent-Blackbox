# Motifcode support

Agent-Blackbox records [Motifcode](https://github.com/TaewoooPark/Motifcode) by following its local v2 session journals. **Motifcode 0.4.2 has been verified with a live Morphfactory model run and an automated harness that runs the installed CLI.** Recording needs no Motifcode plugin, recorder hook, or model connection.

The adapter supports what Motifcode writes to its journal. Some interactive commands and permission decisions never reach that journal; the limits below distinguish those cases from adapter support.

## Start recording

Run the recorder in your project:

```bash
cd /path/to/project
npx @taewooopark/agent-blackbox up --host motifcode
```

In another terminal, use Motifcode in the same project:

```bash
cd /path/to/project
motif
# A normal one-task invocation also writes a journal:
motif "Read the tests, fix the bug, and run the tests."
```

The dashboard opens at `http://127.0.0.1:5173/`. Add `--no-open` to leave browser opening to you. Motifcode itself needs a working provider connection to generate new model responses; Agent-Blackbox only reads the resulting files.

To record all supported hosts together:

```bash
npx @taewooopark/agent-blackbox up --host all
```

This includes Motifcode's `<current-directory>/.motif/sessions/`. It does **not** search your home directory for other Motifcode projects. Other adapters retain their normal global transcript locations.

## Source directories, storage, and history

| Option | Motifcode journal source | Agent-Blackbox trace storage |
|---|---|---|
| No `--project` | `<cwd>/.motif/sessions/` | Global Agent-Blackbox data directory |
| `--project /path/to/project` | `/path/to/project/.motif/sessions/` | `/path/to/project/.agent-blackbox/events.ndjson` |
| `--motifcode-sessions-dir /path/to/journals` | The specified directory, including nested `.jsonl` files | Unchanged by this option; `--project` still controls storage |

Global traces live in `$XDG_DATA_HOME/agent-blackbox/events.ndjson`, or `~/.local/share/agent-blackbox/events.ndjson` when `XDG_DATA_HOME` is unset. Source selection and trace storage are separate: global storage does not imply global Motifcode discovery.

```bash
# Select a project explicitly, also with --host all.
npx @taewooopark/agent-blackbox up --host motifcode --project /path/to/project

# Record journals placed elsewhere using Motifcode's --journal option.
npx @taewooopark/agent-blackbox up --host motifcode \
  --motifcode-sessions-dir /path/to/journals

# Import recent history as well as following new events.
npx @taewooopark/agent-blackbox up --host motifcode \
  --project /path/to/project --backfill-days 7
```

The default is `--backfill-days 0`: existing complete records establish session and tool context, but are not imported as historical events. New records appended after startup are captured. A positive value imports journals **modified** within that many days from their beginning, then follows new writes. `AGENT_BLACKBOX_BACKFILL_DAYS` supplies the same default when the flag is omitted.

The recorder can start before `.motif/sessions/` exists. It discovers new files when Motifcode starts writing, preserves partial JSONL records until their next append, and handles UTF-8 characters split across reads. Restart tests cover continuing an existing journal without reusing earlier event IDs; backfill replay is deduplicated by event identity.

## Capability matrix

“Live” means observed with the configured Morphfactory model. “Installed CLI” means the real Motifcode 0.4.2 executable ran against deterministic responses from a local test provider. “Fixture” means a source-shaped journal or canonical event test, without claiming a live provider exercised that feature.

| Capability | Support and limits | Verification |
|---|---|---|
| Normal one-task and interactive task journals | Each task journal becomes a run; only its new task is imported, so checkpoints and earlier conversation history are not replayed as new work. | Live task; installed CLI; fixtures |
| File reads | `read` results become file activity with observed output sizes. | Live; fixtures |
| File creation and replacement | Successful `write` results distinguish created and replaced files. Failed or declined writes do not become changes. | Live; fixtures |
| Unified patches | Successful `apply_patch` results record additions, edits, and deletions. Header-like hunk content is not treated as another file. | Installed CLI edit; addition/deletion fixtures |
| Shell execution and verification | `bash` records the command, output size, and observed outcome. When the journal has only a boolean outcome, a failing numeric exit code is not invented. | Live failed-then-passing test; fixtures |
| Git operations | Simple leading `git status`, `git commit`, and `git push` commands receive specific event types. Quoted mentions and compound commands remain ordinary shell events. | Fixtures |
| Subagents | Child scopes get separate lanes and run-scoped identities; call IDs are paired within their scope. A failed child does not end the root session. | Installed CLI success/failure; cross-run identity fixtures |
| Skills | Model-invoked `skill` calls record a command event and output size. A slash skill expanded into a task has no separate original slash-command identity in the journal. | Fixtures; source contract |
| Persistent terminal | `term` records a tool result. A terminal remaining alive is not treated as proof that its command finished. | Fixtures |
| MCP calls | Recorded `mcp` calls retain server/method names, outcome, and output size. This does not certify a remote MCP service's setup or authorization. | Fixtures |
| Permissions | The upstream denial response is recognized even though Motifcode marks it `ok: true`; it becomes a denial and a non-executed tool result. Ask/allow UI events are not journaled. | Denial fixtures; source contract |
| Token and cache usage | Provider-reported prompt, completion, and cached counts are captured per request. Cached tokens are part of the whole prompt, not extra input. Missing counts remain missing. | Live path; fixtures and dashboard tests |
| Cost | Provider-reported Infron **credits** are preserved when present. They are not converted to dollars or presented as an account balance. Morphfactory cost is not inferred. | Fixtures; source contract |
| Model metadata | The journal's model is captured. A recorded model change is recognized; between-task `/model` or `/provider` UI actions have no separate journal event. | Live metadata; fixtures |
| Compaction | Compaction emitted inside the model loop is recorded. Manual and between-task compaction are not journaled by 0.4.2. | Fixtures only; no forced live compaction claim |
| Resume and recovery | Recorded resume references, repairs, parse failures, channel changes, and loop failures are retained as events. | Fixtures; installed CLI provider failure and later recovery |
| Streaming | The graph updates as complete journal events arrive. Motifcode intentionally omits per-token display chunks from the journal. | Live; partial-record tests |
| Dashboard, replay, and inspection | Canonical events drive the same graph and timeline used for other hosts, including settled tool results and child failure states. | Live capture; automated graph/daemon tests |
| Efficiency, effectiveness, suggestions, and handoff | Available from the recorded evidence through the shared analysis engine. Scores remain diagnostics; `done` is the agent's completion claim, not proof that a grader passed. | Shared analysis and integration tests |
| Future-run memory | The existing opt-in optimization flow can write its managed block to the project's `AGENTS.md`, which Motifcode reads. Preview/apply/revert remain explicit actions. | Shared optimization tests; source contract |
| In-run actuator | **Not available for Motifcode.** `--optimize` does not install Motifcode hooks or intervene in its live tool calls. | Explicit integration boundary |

Journal schema v2 is the supported contract. The adapter was source-checked against 0.4.1 and 0.4.2; that does not promise compatibility with every older release or a future schema revision.

## Upstream actions that cannot be captured

Motifcode 0.4.2 does not write journal events for these operations:

- `motif --print` / `motif -p`, even when `--journal` is supplied. Use normal task mode or an interactive session for recording.
- Manual `!shell` commands, `#note` additions, and most slash-command UI actions between tasks.
- Permission requests and allow choices shown in the terminal. Denials can be recognized from the subsequent recorded tool result.
- Manual `/compact` and compaction performed between completed tasks. Compaction inside a running model loop is different and does emit an event.
- The original slash-skill command when Motifcode records its expanded task instead.

The adapter does not reconstruct these actions from terminal pixels or repeated checkpoint history. Consequently, “supports Motifcode” does not mean every Motifcode UI action is observable.

## Privacy and measurement

The recorder reads local journals without sending them to a model. Assistant text, reasoning, plans, compaction summaries, parse-failure samples, and tool output are represented by sizes or selected metadata rather than copied wholesale into the normalized trace. User prompts, command text, paths, and diagnostics needed for inspection are redacted using Agent-Blackbox's shared rules and length limits.

The absolute project directory remains a local routing field so the explicit optimization flow can target the right project's `AGENTS.md`. Motifcode's original journals remain unchanged and may contain more detail than the normalized trace. Review what you share; redaction is not a guarantee that every possible secret format will be recognized.

`contextTokens` and textual prefix overlap are local estimates. They are not promoted to measured prompt usage or cache hits. Completion/cache-only reports do not imply a measured zero-token prompt. Missing cache counts remain absent from the trace, although the shared efficiency scorer currently treats absent cache counts as zero when a measured prompt count exists; a low cache score alone cannot establish that the provider had no cache hits. Usage availability depends on the provider; the recorder does not manufacture a bill from missing telemetry. Optional Agent-Blackbox model-based suggestions have their own configuration, separate from recording.

## Validation and reproduction

The checks have three distinct levels:

1. **Live provider run:** on 2026-10-15, installed Motifcode 0.4.2 completed a bounded task with the configured Morphfactory model. Agent-Blackbox captured 71 events across 10 model requests: reads of two files, a failing test, patch/write operations, and a passing Node test before task completion. This demonstrates a real working provider path; it does not claim all providers or every tool were exercised live.
2. **Installed CLI harness:** five scenarios use a local scripted provider with the installed Motifcode executable. They cover file reads/writes/patches, failed-then-passing shell commands, successful and failed subagents, measured usage, HTTP/WebSocket ingestion, graph replay, handoff, a provider HTTP 400 followed by recovery, recorder restart during an active run, and full backfill without duplicate events or usage. This checks the real journal writer without relying on a hosted model choosing a particular sequence of tools.
3. **Automated fixtures and integration tests:** source-shaped records cover optional/missing usage, scopes, permissions, MCP/skills/terminal events, compaction, malformed/partial records, privacy, graph state, replay, and shared analysis. Compaction and permission-denial support are tested here, not claimed as forced live-provider coverage.

From an Agent-Blackbox checkout, install dependencies and build before running the installed-CLI harness:

```bash
npm install
npm run build
npm run test:motifcode -- --motif-bin "$(which motif)"
```

Motifcode must already be installed and available on `PATH`, or pass its executable's absolute path instead of `"$(which motif)"`. The [harness](../e2e/motifcode-integration.mjs) uses a loopback test provider, an isolated child home, and an empty environment file. It makes no external model requests and does not use your hosted-provider credentials. Add `--keep` to retain the temporary journals and `report.json`; their directory is printed at completion. Its deterministic responses validate the integration contract; they are not a benchmark of model quality.

Run the ordinary regression suite separately:

```bash
npm run check
```

## Contract references

The 0.4.2 release resolves to [`c30ebb7`](https://github.com/TaewoooPark/Motifcode/commit/c30ebb7ec23ec252c6b60667f1d6776f310a6753). Relevant upstream sources are:

- [Journal v2 envelopes and scopes](https://github.com/TaewoooPark/Motifcode/blob/c30ebb7ec23ec252c6b60667f1d6776f310a6753/packages/journal/src/index.ts)
- [Loop events and optional usage fields](https://github.com/TaewoooPark/Motifcode/blob/c30ebb7ec23ec252c6b60667f1d6776f310a6753/packages/core/src/events.ts)
- [Tool execution and human-denial result](https://github.com/TaewoooPark/Motifcode/blob/c30ebb7ec23ec252c6b60667f1d6776f310a6753/packages/cli/src/executor.ts#L475)
- [Print-mode boundary and journal path](https://github.com/TaewoooPark/Motifcode/blob/c30ebb7ec23ec252c6b60667f1d6776f310a6753/packages/cli/src/main.ts#L1093)
- [Interactive manual compaction](https://github.com/TaewoooPark/Motifcode/blob/c30ebb7ec23ec252c6b60667f1d6776f310a6753/packages/cli/src/chat.ts#L1612)

Agent-Blackbox's implementation is in [`packages/motifcode-adapter`](../packages/motifcode-adapter/); shared scoring semantics are documented in [Analysis & scoring](./analysis.md).
