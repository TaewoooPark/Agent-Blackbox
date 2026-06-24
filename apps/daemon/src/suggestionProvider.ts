import {
  buildDeterministicSuggestions,
  type EfficiencyReport,
  type Suggestion
} from "@agent-blackbox/core";
import { spawn } from "node:child_process";

// Local/free LLM routing for context-efficiency suggestions. No API keys in the
// default path: Ollama and OpenAI-compatible localhost servers (LM Studio,
// llama.cpp) need none, and the OpenCode free model reuses the user's install.
// Everything degrades gracefully to the always-on deterministic suggestions, and
// only a redacted, derived digest leaves the process: metric counts/sizes plus
// coarse offender labels (file basenames, command verbs) — never file contents,
// full paths, command lines, prompts, or code.

export type SuggestionMode = "auto" | "off" | "free" | "ollama" | "opencode" | "openai-compat";

export type SuggestionConfig = {
  mode: SuggestionMode;
  model?: string;
  baseUrl?: string;
};

export type SuggestionResult = {
  suggestions: Suggestion[];
  provider: string;
};

// On-demand "Optimize" call — give slower local models (and the richer prompt)
// room to finish before falling back to the deterministic floor.
const TIMEOUT_MS = 45_000;
const SYSTEM_PROMPT = `You optimize the context-window economy of AI coding-agent runs. The agent has tools: file read/edit, bash, grep/glob, sub-agents, and prompt caching. You receive a JSON digest of the run's FLAGGED metrics (each: id, value, display, status, detail, reclaimableTokens, offenders). Return ONE concrete fix per flagged metric that the operator can apply on the next run.

# Every action MUST
- Fit the run's "archetype" (task type): research/read-heavy runs SHOULD read widely — don't tell them to read less; debug runs care about retries/rework; ops runs live in command output. Tailor the fix to the task, never generic.
- Ground in this run's numbers: cite the metric's display/reclaimable, and name the offenders verbatim when present (e.g. "config.json ×5").
- Name a concrete mechanism or tool — not a goal. "Reduce context" is banned; "after an edit, re-read only the changed line range instead of the whole file" is right.
- State the expected effect (fewer tokens / cache hits / fewer steps).
- Be one or two sentences. Do not restate the metric or give generic advice.

# Fix playbook (match the flagged id)
- context-pressure: compact resolved turns into a short decisions+open-bugs note and start a fresh window; clear raw tool outputs already acted on; move exploration into a sub-agent that returns a ~1-2k-token summary; keep file paths as references, not full contents.
- cache-hit: cached tokens are ~10x cheaper — keep the prompt prefix byte-stable (no timestamps/per-run data in the system prompt), append-only (never edit earlier turns), deterministic JSON key order, and mask unused tools instead of adding/removing them mid-run (any change voids the cache downstream).
- redundant-reads: read each file once and hold it in working memory or a notes file; after an edit re-read only the changed line range, never the whole file again.
- read-amplification: locate with grep/symbol search, then read only the relevant line range; pre-load a repo map/metadata and fetch on demand instead of whole files.
- large-injections: scope the command (narrow paths, max-count/head) or pipe it through a summary; or have a sub-agent absorb the big output and return only the distilled result.
- retry-waste: don't re-run blindly — read the first failure's stderr, fix the root cause, retry once; keep the failed attempt in context so the model doesn't repeat it.
- yield-density: split into smaller verifiable steps; recite the goal/todo each step to keep it in recent tokens (models under-use the middle of long contexts); offload exploration to a sub-agent to keep the main thread lean.
- tool-overhead: batch related edits into one change, drop exploratory calls that don't lead to an edit, and trim to a minimal non-overlapping tool set.
- edit-thrash: a file was rewritten repeatedly — read the surrounding code once, settle the change, then apply it in as few edits as possible instead of iterating live against tool output.
- big-file-read: a whole large file was pulled into context — locate the relevant lines with grep/symbol search and read only that range (or head/sed a slice).
- exploration-waste: a lot of read text was never edited — move wide exploration into a sub-agent that returns a ~1-2k-token summary, and keep only the files you change in the main thread.

# Contrast (do this)
metricId "redundant-reads", reclaimableTokens ~12000, offenders ["calculator.js ×4"]:
- BAD: "Avoid reading files multiple times to save context."
- GOOD: "calculator.js was read 4× (~12k reclaimable) — read it once and cache it, then after each edit re-read only the changed line range instead of the whole file."

# Output
Respond with ONLY this JSON, one entry per flagged metric, nothing else:
{"suggestions":[{"metricId":"<id>","title":"<=6 words","action":"<specific fix grounded in this run's numbers/offenders>"}]}`;

// A derived, redacted view of the report — counts, sizes, statuses only. No file
// paths, no command lines, no file contents. This is all that reaches a model.
type Digest = {
  overallScore: number;
  headline: string;
  archetype: string; // inferred task type — tailor advice to it (don't tell a research task to read less)
  totalInputTokens: number;
  estimated: boolean;
  metrics: {
    id: string;
    label: string;
    status: string;
    value: number;
    display: string;
    detail: string;
    reclaimableTokens?: number;
    offenders?: string[];
  }[];
};

export function buildDigest(report: EfficiencyReport): Digest {
  return {
    overallScore: report.overallScore,
    headline: report.headline,
    archetype: report.archetype,
    totalInputTokens: report.totalInputTokens,
    estimated: report.estimated,
    metrics: report.metrics
      .filter((m) => m.status !== "good")
      .map((m) => ({
        id: m.id,
        label: m.label,
        status: m.status,
        value: Number((typeof m.value === "number" && Number.isFinite(m.value) ? m.value : 0).toFixed(3)),
        display: m.display,
        detail: m.detail,
        ...(m.reclaimableTokens ? { reclaimableTokens: m.reclaimableTokens } : {}),
        ...(m.offenders && m.offenders.length > 0 ? { offenders: m.offenders } : {})
      }))
  };
}

// A curated pool of FREE models across independent quota pools (OpenCode Zen +
// Ollama cloud + local). `auto`/`free` rotate through it so a real user can keep
// the AI suggestions running, free, for a long time: one model per call (light),
// rotated to spread load, with quota errors failing over and cooling the
// throttled model down. Local llama3.1 has no quota and is the always-on floor.
type FreePoolEntry = { provider: "ollama" | "opencode"; model: string };
const FREE_POOL: FreePoolEntry[] = [
  { provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
  { provider: "opencode", model: "opencode/north-mini-code-free" },
  { provider: "ollama", model: "qwen3-coder:480b-cloud" },
  { provider: "opencode", model: "opencode/mimo-v2.5-free" },
  { provider: "ollama", model: "gpt-oss:120b-cloud" },
  { provider: "ollama", model: "llama3.1:8b" }
];
const FREE_COOLDOWN_MS = 10 * 60_000; // skip a 429'd model for 10 minutes
let freeCursor = 0;
const freeCooldownUntil = new Map<string, number>();

// Order the pool for this call: drop models still cooling down, then rotate by
// the cursor so consecutive suggestions hit different pools. If everything is
// cooling down, try the whole pool anyway (better than giving up).
export function orderFreePool<T extends { model: string }>(
  pool: T[],
  cooldownUntil: Map<string, number>,
  cursor: number,
  now: number
): T[] {
  const fresh = pool.filter((entry) => (cooldownUntil.get(entry.model) ?? 0) <= now);
  const list = fresh.length > 0 ? fresh : pool;
  if (list.length === 0) return [];
  const start = ((cursor % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

export function isQuotaError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("usage limit") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("quota")
  );
}

export async function generateSuggestions(report: EfficiencyReport, config: SuggestionConfig): Promise<SuggestionResult> {
  const deterministic = buildDeterministicSuggestions(report);
  if (config.mode === "off" || deterministic.length === 0) {
    return { suggestions: deterministic, provider: "deterministic" };
  }
  const digest = buildDigest(report);

  // auto/free (no pinned model): rotate the free pool, fail over on quota errors,
  // cool throttled models down. One successful call per suggestion → light + durable.
  if ((config.mode === "auto" || config.mode === "free") && !config.model) {
    const order = orderFreePool(FREE_POOL, freeCooldownUntil, freeCursor, Date.now());
    freeCursor += 1;
    for (const entry of order) {
      try {
        const llm = await callProvider(entry.provider, digest, { ...config, model: entry.model });
        const validated = validateSuggestions(llm, report);
        if (validated.length > 0) {
          return { suggestions: mergeSuggestions(deterministic, validated), provider: entry.model };
        }
      } catch (error) {
        if (isQuotaError(error)) freeCooldownUntil.set(entry.model, Date.now() + FREE_COOLDOWN_MS);
        // otherwise unavailable/parse error — just try the next model
      }
    }
    return { suggestions: deterministic, provider: "deterministic" };
  }

  // Explicit provider (or auto/free with a pinned --suggest-model): single chain.
  const order: ("ollama" | "openai-compat" | "opencode")[] =
    config.mode === "auto" || config.mode === "free" ? ["ollama"] : [config.mode];
  for (const provider of order) {
    try {
      const llm = await callProvider(provider, digest, config);
      const validated = validateSuggestions(llm, report);
      if (validated.length > 0) {
        return { suggestions: mergeSuggestions(deterministic, validated), provider };
      }
    } catch {
      // Provider unavailable or errored — fall through to the next / deterministic.
    }
  }
  return { suggestions: deterministic, provider: "deterministic" };
}

async function callProvider(
  provider: "ollama" | "openai-compat" | "opencode",
  digest: Digest,
  config: SuggestionConfig
): Promise<unknown> {
  if (provider === "ollama") return callOllama(digest, config);
  if (provider === "openai-compat") return callOpenAICompat(digest, config);
  return callOpenCode(digest, config);
}

async function callOllama(digest: Digest, config: SuggestionConfig): Promise<unknown> {
  const baseUrl = config.baseUrl ?? "http://127.0.0.1:11434";
  const model = config.model ?? "llama3.1";
  const response = await fetchJson(`${baseUrl}/api/chat`, {
    model,
    stream: false,
    format: "json",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(digest) }
    ]
  });
  // Ollama returns 200 with an {error} body when the cloud quota is hit — surface
  // it so the caller can fail over and cool the model down.
  const err = (response as { error?: unknown })?.error;
  if (err) throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  const content = (response as { message?: { content?: string } })?.message?.content;
  return content ? JSON.parse(content) : undefined;
}

async function callOpenAICompat(digest: Digest, config: SuggestionConfig): Promise<unknown> {
  if (!config.baseUrl) throw new Error("openai-compat needs --suggest-base-url");
  const model = config.model ?? "local-model";
  const apiKey = process.env.AGENT_BLACKBOX_SUGGEST_KEY; // optional; localhost servers ignore it
  const response = await fetchJson(
    `${config.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
    {
      model,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(digest) }
      ]
    },
    apiKey ? { authorization: `Bearer ${apiKey}` } : {}
  );
  const content = (response as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
  return content ? JSON.parse(content) : undefined;
}

// Reuse the locally-installed opencode binary with a free model — no API key.
async function callOpenCode(digest: Digest, config: SuggestionConfig): Promise<unknown> {
  const model = config.model ?? "opencode/deepseek-v4-flash-free";
  const prompt =
    `${SYSTEM_PROMPT}\n\nMetrics:\n${JSON.stringify(digest)}\n\n` +
    `Output ONLY the JSON object, nothing else.`;
  const stdout = await runCommand("opencode", ["run", "--model", model, prompt]);
  return extractJsonObject(stdout);
}

function mergeSuggestions(deterministic: Suggestion[], llm: Suggestion[]): Suggestion[] {
  const llmByMetric = new Map(llm.map((s) => [s.metricId, s]));
  // Prefer the model's tailored suggestion per metric; keep the deterministic
  // one wherever the model didn't produce a usable answer.
  return deterministic.map((d) => llmByMetric.get(d.metricId) ?? d);
}

function validateSuggestions(raw: unknown, report: EfficiencyReport): Suggestion[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { suggestions?: unknown[] })?.suggestions)
      ? (raw as { suggestions: unknown[] }).suggestions
      : [];
  const statusByMetric = new Map(report.metrics.map((m) => [m.id, m.status]));
  const out: Suggestion[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const metricId = (item as { metricId?: unknown }).metricId;
    const action = (item as { action?: unknown }).action;
    const title = (item as { title?: unknown }).title;
    if (typeof metricId !== "string" || typeof action !== "string" || action.trim().length < 8) continue;
    const status = statusByMetric.get(metricId);
    if (status !== "warn" && status !== "bad") continue; // only flagged metrics
    out.push({
      metricId,
      severity: status,
      title: typeof title === "string" && title.length > 0 ? title : metricId,
      action: action.trim().slice(0, 400),
      source: "llm"
    });
  }
  return out;
}

async function fetchJson(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // AGENT_BLACKBOX_DISABLE: the suggestion model is invoked via `opencode run`,
    // which the globally-installed recorder would otherwise capture as its own
    // trivial run — hijacking "latest run" and resetting the dashboard score.
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, AGENT_BLACKBOX_DISABLE: "1" }
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("opencode timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`opencode exited ${code}`));
    });
  });
}

// Pull the first balanced JSON object out of noisy CLI output.
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
