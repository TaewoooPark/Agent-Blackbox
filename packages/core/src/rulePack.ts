import type { TraceEvent } from "./events.js";

// Pluggable rule packs — let a project encode its own "diverse cases" on top of the
// built-in 8 metrics, declaratively (no arbitrary code, so a pack is safe to load
// and ship). e.g. "never read node_modules", "run tests before committing". Rules
// are pure predicates over the events; findings surface as custom checks alongside
// the metrics, NOT folded into the efficiency score (so one project's house rules
// don't distort cross-project baselines).

export type RuleSeverity = "info" | "warn" | "bad";

export type Rule = {
  id: string;
  type: "forbid-read" | "forbid-edit" | "forbid-bash" | "max-reads" | "require-before-commit";
  pattern: string; // regex (tested against full path / command), compiled safely
  limit?: number; // for max-reads
  message?: string;
  severity?: RuleSeverity;
};

export type RulePack = { rules: Rule[] };

export type RuleFinding = {
  ruleId: string;
  severity: RuleSeverity;
  message: string;
  offenders: string[]; // redacted (basenames / verbs)
};

const RULE_TYPES = new Set<Rule["type"]>(["forbid-read", "forbid-edit", "forbid-bash", "max-reads", "require-before-commit"]);
const MAX_RULES = 50;
const MAX_PATTERN_LEN = 200;
const MAX_INPUT_LEN = 2000; // cap the string a pattern is tested against (paths/commands are short)

// Patterns prone to catastrophic backtracking. A rules.json may ride in with a
// cloned repo, so an untrusted `(a+)+$` must not hang the daemon's event loop AND
// the dashboard's UI thread (which re-evaluates every snapshot). This rejects the
// classic ReDoS shapes — a quantified group/class that itself contains a
// quantifier, and very large bounded repetition — before compiling.
// A group that itself contains a quantifier and is then quantified again — the
// classic `(a+)+`, `(.*,)*`, `(a+){2,}` shapes. (Not a perfect ReDoS detector; the
// MAX_INPUT_LEN cap is the backstop for the rest.)
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*([+*]|\{)/;
const HUGE_REPETITION = /\{\s*\d{4,}/;

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const verb = (c: string): string => c.trim().split(/\s+/)[0] ?? c;
const capInput = (s: string): string => (s.length > MAX_INPUT_LEN ? s.slice(0, MAX_INPUT_LEN) : s);
const str = (e: TraceEvent, k: string): string | undefined =>
  typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined;

// Compile a pattern defensively: bounded length, no catastrophic-backtracking
// shapes, invalid regex → null (rule skipped, never throws).
function safeRegex(pattern: string): RegExp | null {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LEN) return null;
  if (NESTED_QUANTIFIER.test(pattern) || HUGE_REPETITION.test(pattern)) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Parse + validate an untrusted rule pack (e.g. from a project config file). Drops
 * malformed rules and bad regexes instead of throwing, so one typo can't break the
 * whole pack. Returns an empty pack for anything unrecognisable.
 */
export function parseRulePack(raw: unknown): RulePack {
  const rules = (raw as { rules?: unknown })?.rules;
  if (!Array.isArray(rules)) return { rules: [] };
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (out.length >= MAX_RULES) break;
    if (typeof r !== "object" || r === null) continue;
    const rule = r as Partial<Rule>;
    if (typeof rule.id !== "string" || !rule.type || !RULE_TYPES.has(rule.type)) continue;
    if (typeof rule.pattern !== "string" || safeRegex(rule.pattern) === null) continue;
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push({
      id: rule.id,
      type: rule.type,
      pattern: rule.pattern,
      ...(typeof rule.limit === "number" && Number.isFinite(rule.limit) ? { limit: rule.limit } : {}),
      ...(typeof rule.message === "string" ? { message: rule.message.slice(0, 200) } : {}),
      ...(rule.severity === "info" || rule.severity === "warn" || rule.severity === "bad" ? { severity: rule.severity } : {})
    });
  }
  return { rules: out };
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

export function evaluateRulePack(events: TraceEvent[], pack: RulePack): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const rule of pack.rules) {
    const re = safeRegex(rule.pattern);
    if (!re) continue;
    const severity = rule.severity ?? "warn";
    const offenders: string[] = [];

    if (rule.type === "forbid-read" || rule.type === "forbid-edit") {
      const kind = rule.type === "forbid-read" ? "file_read" : "file_edit";
      for (const e of events) {
        if (e.kind !== kind) continue;
        const path = str(e, "path");
        if (path && re.test(capInput(path))) offenders.push(baseName(path));
      }
    } else if (rule.type === "forbid-bash") {
      for (const e of events) {
        if (e.kind !== "bash") continue;
        const c = str(e, "command");
        if (c && re.test(capInput(c))) offenders.push(verb(c));
      }
    } else if (rule.type === "max-reads") {
      const limit = rule.limit ?? 1;
      const counts = new Map<string, number>();
      for (const e of events) {
        if (e.kind !== "file_read") continue;
        const path = str(e, "path");
        if (path && re.test(capInput(path))) counts.set(path, (counts.get(path) ?? 0) + 1);
      }
      for (const [path, n] of counts) if (n > limit) offenders.push(`${baseName(path)} ×${n}`);
    } else if (rule.type === "require-before-commit") {
      // A git_commit must be preceded (by seq) by a passing bash command matching
      // the pattern (e.g. tests/typecheck). Flag commits that aren't.
      const ordered = [...events].sort((a, b) => a.seq - b.seq);
      let satisfiedSince = false;
      for (const e of ordered) {
        if (e.kind === "bash" && str(e, "command") && re.test(capInput(str(e, "command")!))) {
          const code = e.payload.exitCode;
          if (typeof code !== "number" || code === 0) satisfiedSince = true;
        }
        if (e.kind === "git_commit") {
          if (!satisfiedSince) offenders.push("commit");
          satisfiedSince = false; // each commit needs its own preceding check
        }
      }
    }

    if (offenders.length > 0) {
      findings.push({
        ruleId: rule.id,
        severity,
        message: rule.message ?? defaultMessage(rule),
        offenders: dedupe(offenders).slice(0, 5)
      });
    }
  }
  return findings;
}

function defaultMessage(rule: Rule): string {
  switch (rule.type) {
    case "forbid-read":
      return "Read a file this project's rules say to avoid.";
    case "forbid-edit":
      return "Edited a file this project's rules say to avoid.";
    case "forbid-bash":
      return "Ran a command this project's rules flag.";
    case "max-reads":
      return `Read a file more than ${rule.limit ?? 1}×.`;
    case "require-before-commit":
      return "Committed without the required check passing first.";
    default:
      return "Custom rule triggered.";
  }
}
