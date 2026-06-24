# Analysis & scoring reference

How Agent-Blackbox turns a recorded run into scores, advice, and a written-back
memory. Everything here is derived from **observed events** (sizes, token
snapshots, exit codes) — never the agent's self-report — and computed by pure,
deterministic functions in `@agent-blackbox/core`, so the daemon can replay them
at any point and the dashboard can recompute them live for the run you're viewing.

> Heads-up on honesty: the two scores below are **diagnostics, not verdicts**.
> Efficiency is measured; effectiveness and the task archetype are **heuristics**
> with explicit confidence. See [Known limitations](#known-limitations).

---

## Two axes

A run is scored on two independent axes, because a run can be one without the other:

| Axis | Question | How it's derived |
|---|---|---|
| **Efficiency** | Did it use the context window economically? | 11 weighted metrics (below) → 0–100 |
| **Effectiveness** | Did the task actually land? | outcome + verification + failure signals → 0–100 **heuristic** with a confidence flag |

A debug run can score **efficiency 63 / effectiveness 100** (wasteful but it
shipped + tests passed + committed); a clean-looking run that errored out can
score high efficiency but low effectiveness. They are never combined into one
number.

---

## Efficiency metrics

Each metric scores 0–100 and is `good` / `warn` / `bad`. The overall score is the
weighted average. Thresholds are the current defaults (`packages/core/src/efficiency.ts`).

| id | What it catches | warn / bad | weight |
|---|---|---|---|
| `context-pressure` | peak input tokens | > 100k / > 180k | 1.5 |
| `cache-hit` | prompt-cache reuse (only when the model reports cache telemetry) | < 60% / < 30% | 1.0 |
| `redundant-reads` | the same file read more than once | ≥ 1 / ≥ 3 file (or ≥ 10k reclaimable) | 2.0 |
| `read-amplification` | read tokens ÷ edited tokens (only when edits exist) | > 40× / > 120× | 2.0 |
| `large-injections` | the biggest single tool/bash output | ≥ 5k / ≥ 15k | 1.5 |
| `retry-waste` | identical commands re-run | ≥ 1 / ≥ 3 | 2.0 |
| `yield-density` | concrete outcomes per 1k input tokens | < 0.05 / < 0.02 | 1.0 |
| `tool-overhead` | tool calls ÷ outcomes | > 2× / > 4× | 0.5 |
| `edit-thrash` | one file rewritten many times (rework) | > 2× / > 4× | 1.0 |
| `big-file-read` | a single oversized `file_read` pulled in whole | ≥ 12k / ≥ 30k | 1.0 |
| `exploration-waste` | read text never edited (edit-oriented runs only) | ≥ 30k / ≥ 80k | 0.5 |

Each flagged metric carries coarse **offenders** (file basenames, command verbs)
so advice can name what to fix.

---

## Task archetypes (task-tailored scoring)

The same absolute thresholds would unfairly ding a research run for reading
widely. So each run is classified — deterministically, no model — into an
archetype, and the score is judged on a yardstick that fits it.

`classifyRun(events)` → one of `research` · `debug` · `feature` · `ops` · `edit`
· `unknown`, plus a **confidence** (0–1) and human-readable signals.

Conditioning (`ARCHETYPE_PROFILES`) is applied **only when confidence ≥ 0.55** —
below the bar the run is scored neutrally (identical to the unconditioned report)
so an early/just-started run doesn't swing as the classifier settles. Two levers:

- **`expected`** dims are forced to `good` (they lift, never drag, the score)
  because doing them *is* the job. e.g. on `research`: `read-amplification`,
  `big-file-read`, `exploration-waste`, `large-injections`.
- **`weight` multipliers** (always > 1) emphasise what matters for the type. e.g.
  on `debug`: `retry-waste`, `edit-thrash`, `yield-density` ×1.5.

Neutral archetypes (`edit` / `feature` / `unknown`) leave the score byte-identical
to the unconditioned report.

---

## Effectiveness (the second axis)

`computeEffectiveness(events, promiseChecks)` — a heuristic from observable signals:

- **Output** — edits / creates / commits (a clean commit needs exit 0).
- **Verification** — the last test/build command's exit code (passed / failed).
- **Failure load** — `session_error` (hard, −15) vs transient `host_event`
  api errors (soft, −1, capped at −8: they're usually auto-retried), and the
  failed-command ratio.
- **Contradicted claims** — promise-checks the trace contradicts.

It carries a **confidence** (`low` / `medium` / `high`) from how many independent
signals fired, and pulls back toward neutral on low signal — so a read-only run
reads **`unclear`** (and the dashboard hides the chip), not "failed". The
`succeeded` label is reserved for **high** confidence; a good score on medium
evidence reads `likely ok`.

---

## Relative baselines

Absolute thresholds can't know what's normal *for you*. The daemon keeps a small
rolling history of per-run summaries (`<dataDir>/baselines.json`, ≤ 50, throttled,
best-effort) and the dashboard scores the viewed run against it:

> *"score 40 vs your usual 87 for research (4 runs) · 33× the tokens"*

`compareToBaseline` compares only against **same-archetype, same-project** peers
(scoped by the run's dominant-cwd basename, so a global daemon recording many
repos doesn't mix them), **excludes the run itself**, and stays `insufficient`
until there are ≥ 3 prior samples — it never invents a trend from one run.

---

## Accumulative optimize memory

`optimize` writes a cache-safe block into the project's `CLAUDE.md` (Claude Code)
or `AGENTS.md` (everyone else) at `<project>/.agent-blackbox/efficiency-profile.json`.
Rather than regenerating from only the last run, it **accrues across runs**: each
accrue decays every weight ×0.8 then adds the run's levers (+1). A pattern seen
every run converges high and is annotated **`(×N)`**; a one-off decays below the
prune floor after ~5 runs and drops. Accrual is **idempotent per runId**, so
`preview` shows exactly what `apply` will write but doesn't persist; `apply` does.

---

## Causal timeline (for model-tailored advice)

When you press **Generate advice**, the dashboard attaches a compact, redacted
action **timeline** to the request (`buildCausalTimeline`). A read is tagged
`reread` **only** when the same path was already read *and no compaction happened
since* — so the model won't scold a legitimate re-read after a context compaction
(the window was reset). Vocabulary: `read` `reread` `edit` `create` `bash`
`search` `compact` `error` `subagent` (targets are basenames / command verbs only).

---

## Rule packs — custom checks

Drop a `<project>/.agent-blackbox/rules.json` to add project-specific checks on
top of the built-in metrics. They surface as **Custom checks** in the dashboard
and are **not** folded into the efficiency score (so house rules don't distort
cross-project baselines). Loaded best-effort: a malformed rule or bad regex is
dropped (never throws), and patterns prone to catastrophic backtracking (ReDoS)
are rejected before compiling.

```jsonc
{
  "rules": [
    // Flag reading vendored/generated code.
    { "id": "no-vendor", "type": "forbid-read", "pattern": "node_modules|/dist/", "severity": "warn",
      "message": "Don't read vendored/generated code — it's huge and unowned." },

    // Flag editing generated files.
    { "id": "no-edit-lock", "type": "forbid-edit", "pattern": "package-lock\\.json$" },

    // Flag a dangerous command.
    { "id": "no-force-push", "type": "forbid-bash", "pattern": "push\\s+--force", "severity": "bad" },

    // Flag reading the same matching file too often.
    { "id": "config-once", "type": "max-reads", "pattern": "config\\.(json|ya?ml)$", "limit": 1 },

    // Flag a commit with no passing check (matching the pattern) before it.
    { "id": "test-first", "type": "require-before-commit", "pattern": "npm (run )?(test|build)",
      "severity": "bad", "message": "Run tests before committing." }
  ]
}
```

| field | required | notes |
|---|---|---|
| `id` | yes | unique; duplicates are dropped |
| `type` | yes | `forbid-read` · `forbid-edit` · `forbid-bash` · `max-reads` · `require-before-commit` |
| `pattern` | yes | JS regex string (≤ 200 chars), tested against the full path / command |
| `limit` | for `max-reads` | integer; flag when a matching path is read more than this |
| `severity` | no | `info` · `warn` (default) · `bad` |
| `message` | no | shown verbatim; a sensible default is used otherwise |

Findings are **redacted** — offenders are basenames and command verbs, never full
paths or command lines.

---

## Privacy

Only a **redacted, derived digest** ever leaves the process, even to a local
model: metric statuses, counts, sizes, the archetype, the action timeline, and
coarse offender labels (file basenames, command verbs) — **never file contents,
directory paths, command arguments, prompts, or secrets**. All baseline / profile
/ rule state is local files under `<project>/.agent-blackbox/` and the daemon's
data dir.

---

## Known limitations

Stated plainly, because these are heuristics:

- **Effectiveness is a heuristic.** It reads outcome signals (edits, exit codes,
  commits), not semantic correctness — a run whose tests pass but whose change is
  *wrong* can still read `succeeded`. Treat it as a signal, weigh the confidence.
- **Archetype can misclassify.** A debug session with no test command may read as
  `edit`; the confidence gate and neutral fallback limit the damage, but it's a
  guess.
- **Accumulative memory mixes tasks within a project.** It's scoped per project,
  not per task type — a project's research-run levers and feature-run levers
  share one profile (decay mitigates, but doesn't separate them).
- **The timeline's re-read detection spans subagent lanes.** A subagent reading a
  file the main agent read counts as a `reread` even though they have separate
  context windows.
- **Baselines / effectiveness need real signal.** Token-economy figures are
  size-estimated when the model reports no token telemetry (`estimated: true`);
  effectiveness reads `unclear` until enough outcome signal exists.
