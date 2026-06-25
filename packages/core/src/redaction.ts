import type { JsonObject, JsonValue } from "./json.js";
import { isJsonObject } from "./json.js";

export type RedactionRule = {
  name: string;
  pattern: RegExp;
  replacement: string;
};

export type RedactionOptions = {
  maxStringLength?: number;
  homeDir?: string;
  projectDir?: string;
  extraRules?: RedactionRule[];
};

export type RedactionResult<T extends JsonValue> = {
  value: T;
  rulesApplied: string[];
  truncated: boolean;
};

export const defaultRedactionRules: RedactionRule[] = [
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]"
  },
  {
    name: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]"
  },
  {
    name: "openai-key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]"
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
    replacement: "Bearer [REDACTED_TOKEN]"
  },
  {
    name: "secret-assignment",
    pattern: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?\s*[:=]\s*["']?[^\s'\"]{8,}/gi,
    replacement: "$1=[REDACTED_SECRET]"
  },
  {
    name: "private-key",
    // Tempered quantifier: the body cannot cross another BEGIN marker. Without it, a
    // lone BEGIN with no END forces a scan to end-of-string from every BEGIN — O(n²)
    // backtracking on untrusted tool output peppered with BEGIN markers (slow-path DoS).
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  }
];

export function redactJsonObject(payload: JsonObject, options: RedactionOptions = {}): RedactionResult<JsonObject> {
  return redactJsonValue(payload, options) as RedactionResult<JsonObject>;
}

export function redactJsonValue<T extends JsonValue>(
  value: T,
  options: RedactionOptions = {}
): RedactionResult<T> {
  const rules = [...defaultRedactionRules, ...(options.extraRules ?? [])];
  const applied = new Set<string>();
  let truncated = false;
  const maxStringLength = options.maxStringLength ?? 4000;

  const visit = (current: JsonValue): JsonValue => {
    if (typeof current === "string") {
      let next = current;
      if (options.projectDir) {
        next = replaceDir(next, options.projectDir, "$PROJECT", "project-dir", applied);
      }
      if (options.homeDir) {
        next = replaceDir(next, options.homeDir, "~", "home-dir", applied);
      }
      for (const rule of rules) {
        if (rule.pattern.test(next)) {
          applied.add(rule.name);
          next = next.replace(rule.pattern, rule.replacement);
        }
        rule.pattern.lastIndex = 0;
      }
      if (next.length > maxStringLength) {
        truncated = true;
        applied.add("truncate-string");
        return `${next.slice(0, maxStringLength)}...[TRUNCATED ${next.length - maxStringLength} chars]`;
      }
      return next;
    }
    if (Array.isArray(current)) {
      return current.map((item) => visit(item));
    }
    if (isJsonObject(current)) {
      const next: JsonObject = {};
      for (const [key, nested] of Object.entries(current)) {
        next[key] = visit(nested);
      }
      return next;
    }
    return current;
  };

  return {
    value: visit(value) as T,
    rulesApplied: [...applied].sort(),
    truncated
  };
}

// A home/project dir must be stripped no matter which path-separator style a value
// uses. On Windows the dir is "C:\\proj" but a tool may emit "C:/proj" for the same
// path (Claude Code mixes the two), and a literal match on one form would miss the
// other — leaving an absolute home path (a leak) in the trace and skipping the
// $PROJECT/~ rewrite. Replace every separator variant; it only ever redacts more.
function replaceDir(
  value: string,
  dir: string,
  replacement: string,
  ruleName: string,
  applied: Set<string>
): string {
  let next = value;
  for (const variant of dirSeparatorVariants(dir)) {
    next = replaceLiteral(next, variant, replacement, ruleName, applied);
  }
  return next;
}

function dirSeparatorVariants(dir: string): string[] {
  const slash = dir.replace(/\\/g, "/");
  const back = dir.replace(/\//g, "\\");
  return slash === back ? [dir] : [slash, back];
}

function replaceLiteral(
  value: string,
  search: string,
  replacement: string,
  ruleName: string,
  applied: Set<string>
): string {
  if (!search || !value.includes(search)) {
    return value;
  }
  applied.add(ruleName);
  return value.split(search).join(replacement);
}

