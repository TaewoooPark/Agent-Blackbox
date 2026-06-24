import type { EfficiencyReport } from "./efficiency.js";

// Closing the loop: turn an observed run's efficiency report into a small,
// cache-safe "memory" block that an agent reads on its NEXT run (AGENTS.md /
// CLAUDE.md). Pure string transforms so the daemon can apply/upsert/revert them
// idempotently and the result is fully testable.

export const EFFICIENCY_MEMORY_START = "<!-- agent-blackbox:efficiency:start -->";
export const EFFICIENCY_MEMORY_END = "<!-- agent-blackbox:efficiency:end -->";

export type EfficiencyMemoryOptions = {
  // Distinct commands observed to succeed, so the next run reuses them instead of
  // rediscovering (cuts exploration / read-amplification). The daemon extracts
  // these from `bash` events with exitCode 0; written to the project's own
  // AGENTS.md (local), so full commands are fine here.
  verifiedCommands?: string[];
};

// The leading label of an offender string ("calculator.js ×2" -> "calculator.js",
// "grep ~12k" -> "grep").
const offenderLabel = (offender: string): string => offender.split(/\s+/)[0] ?? offender;

const dedupe = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];

/**
 * Build the managed memory block (markers included) from a run's report, or
 * `null` when the run was clean enough that there's nothing worth pinning.
 * Deliberately terse: every line added here is context the next run must carry,
 * so it must earn its place or it worsens the very pressure it aims to cut.
 */
// The flag-only levers (no offender list — a whole-run habit). Order = render order.
export const MEMORY_FLAG_LEVERS = ["context-pressure", "cache-hit", "tool-overhead", "edit-thrash"] as const;
export type MemoryFlagLever = (typeof MEMORY_FLAG_LEVERS)[number];

// A normalised, render-ready set of levers, decoupled from where they came from
// (a single run's report, or a profile accumulated across runs). Labels are
// pre-formatted strings, so the accumulator can append "(×N)" without the renderer
// needing to know about counts.
export type MemoryLevers = {
  commands: string[];
  reread: string[]; // redundant-reads ∪ read-amplification
  injections: string[]; // large-injections
  bigReads: string[]; // big-file-read
  retries: string[]; // retry-waste
  flags: Set<MemoryFlagLever>;
};

export function leversFromReport(report: EfficiencyReport, options: EfficiencyMemoryOptions = {}): MemoryLevers {
  const flagged = new Map(report.metrics.filter((m) => m.status !== "good").map((m) => [m.id, m]));
  const offendersOf = (id: string): string[] => (flagged.get(id)?.offenders ?? []).map(offenderLabel);
  return {
    commands: dedupe(options.verifiedCommands ?? []).slice(0, 4),
    reread: dedupe([...offendersOf("redundant-reads"), ...offendersOf("read-amplification")]).slice(0, 6),
    injections: dedupe(offendersOf("large-injections")).slice(0, 4),
    bigReads: dedupe(offendersOf("big-file-read")).slice(0, 4),
    retries: dedupe(offendersOf("retry-waste")).slice(0, 4),
    flags: new Set(MEMORY_FLAG_LEVERS.filter((id) => flagged.has(id)))
  };
}

// Render a lever set into the managed block (markers included), or null when there's
// nothing worth pinning. The single source of the line templates — both the
// single-run and accumulated paths go through here.
export function renderMemoryBlock(levers: MemoryLevers, headerNote: string): string | null {
  const lines: string[] = [];
  if (levers.commands.length > 0) {
    lines.push(`- **Reuse these verified commands** (don't rediscover): ${levers.commands.map((c) => `\`${c}\``).join(", ")}`);
  }
  if (levers.reread.length > 0) {
    lines.push(
      `- **Read these once, then reuse** — re-read only the changed line range after an edit, never the whole file: ${levers.reread.join(", ")}`
    );
  }
  if (levers.injections.length > 0) {
    lines.push(`- **Scope these large outputs** (narrow paths, \`max-count\`/\`head\`, or summarise): ${levers.injections.join(", ")}`);
  }
  if (levers.bigReads.length > 0) {
    lines.push(
      `- **Read these in ranges, not whole** (grep/symbol-search or \`head\`/\`sed\` to the relevant lines): ${levers.bigReads.join(", ")}`
    );
  }
  if (levers.retries.length > 0) {
    lines.push(`- **Fix the root cause before re-running** (read the first failure's stderr): ${levers.retries.join(", ")}`);
  }
  if (levers.flags.has("context-pressure")) {
    lines.push(
      "- **Keep the window lean**: compact resolved turns into a short decisions + open-bugs note, and delegate deep exploration to a sub-agent that returns a brief summary."
    );
  }
  if (levers.flags.has("cache-hit")) {
    lines.push(
      "- **Protect the prompt cache**: keep the prefix byte-stable (no timestamps/volatile data) and append turns instead of editing earlier ones."
    );
  }
  if (levers.flags.has("tool-overhead")) {
    lines.push("- **Batch related edits** into one change; skip exploratory tool calls that don't lead to an edit.");
  }
  if (levers.flags.has("edit-thrash")) {
    lines.push(
      "- **Settle the approach before editing**: a file was rewritten repeatedly — read the surrounding code once, decide, then edit in as few passes as possible."
    );
  }

  if (lines.length === 0) return null;
  return [EFFICIENCY_MEMORY_START, "## Context-efficiency notes", `<!-- ${headerNote} -->`, "", ...lines, EFFICIENCY_MEMORY_END].join("\n");
}

export function buildEfficiencyMemory(report: EfficiencyReport, options: EfficiencyMemoryOptions = {}): string | null {
  return renderMemoryBlock(
    leversFromReport(report, options),
    "Auto-generated by Agent-Blackbox from the last run. Put your own notes ABOVE this block; everything between these markers is regenerated."
  );
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const managedBlockRegExp = (): RegExp =>
  new RegExp(`${escapeRegExp(EFFICIENCY_MEMORY_START)}[\\s\\S]*?${escapeRegExp(EFFICIENCY_MEMORY_END)}`, "g");

export function hasManagedBlock(content: string): boolean {
  return managedBlockRegExp().test(content);
}

/**
 * Insert or replace the managed block. The block goes at the END of the file
 * (and replaces in place if it already exists) so the stable prefix an agent's
 * prompt cache depends on is never disturbed.
 */
export function upsertManagedBlock(content: string, block: string): string {
  if (hasManagedBlock(content)) {
    return content.replace(managedBlockRegExp(), () => block);
  }
  const base = content.trimEnd();
  return base.length === 0 ? `${block}\n` : `${base}\n\n${block}\n`;
}

// Matches the managed block together with the blank lines immediately
// surrounding it, so removal collapses ONLY the seam left behind — user content
// above the block (which may legitimately contain runs of 3+ newlines, e.g.
// inside fenced code blocks) is left byte-for-byte unchanged.
const managedBlockSeamRegExp = (): RegExp =>
  new RegExp(`\\n*${escapeRegExp(EFFICIENCY_MEMORY_START)}[\\s\\S]*?${escapeRegExp(EFFICIENCY_MEMORY_END)}\\n*`, "g");

export function removeManagedBlock(content: string): string {
  if (!hasManagedBlock(content)) return content;
  const stripped = content.replace(managedBlockSeamRegExp(), "\n\n").trimEnd();
  return stripped.length === 0 ? "" : `${stripped}\n`;
}
