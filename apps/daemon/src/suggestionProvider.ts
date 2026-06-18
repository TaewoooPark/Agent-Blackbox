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
// only a redacted, derived digest (no raw code/prompts) ever leaves the process.

export type SuggestionMode = "auto" | "off" | "ollama" | "opencode" | "openai-compat";

export type SuggestionConfig = {
  mode: SuggestionMode;
  model?: string;
  baseUrl?: string;
};

export type SuggestionResult = {
  suggestions: Suggestion[];
  provider: string;
};

const TIMEOUT_MS = 25_000;
const SYSTEM_PROMPT =
  "You are a context-efficiency optimizer for AI coding-agent runs. You are given " +
  "metrics describing how economically a run used its LLM context window. For each " +
  "flagged metric, give one specific, actionable optimization. Be concrete and brief " +
  '(one or two sentences, no fluff). Respond ONLY with JSON of the form ' +
  '{"suggestions":[{"metricId":"<id>","title":"<short>","action":"<advice>"}]}.';

// A derived, redacted view of the report — counts, sizes, statuses only. No file
// paths, no command lines, no file contents. This is all that reaches a model.
type Digest = {
  overallScore: number;
  headline: string;
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
  }[];
};

export function buildDigest(report: EfficiencyReport): Digest {
  return {
    overallScore: report.overallScore,
    headline: report.headline,
    totalInputTokens: report.totalInputTokens,
    estimated: report.estimated,
    metrics: report.metrics
      .filter((m) => m.status !== "good")
      .map((m) => ({
        id: m.id,
        label: m.label,
        status: m.status,
        value: Number(m.value.toFixed(3)),
        display: m.display,
        detail: m.detail,
        ...(m.reclaimableTokens ? { reclaimableTokens: m.reclaimableTokens } : {})
      }))
  };
}

export async function generateSuggestions(report: EfficiencyReport, config: SuggestionConfig): Promise<SuggestionResult> {
  const deterministic = buildDeterministicSuggestions(report);
  if (config.mode === "off" || deterministic.length === 0) {
    return { suggestions: deterministic, provider: "deterministic" };
  }
  const digest = buildDigest(report);
  const order: Exclude<SuggestionMode, "auto" | "off">[] =
    config.mode === "auto" ? ["ollama", "openai-compat", "opencode"] : [config.mode];

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
  provider: Exclude<SuggestionMode, "auto" | "off">,
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
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
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
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
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
