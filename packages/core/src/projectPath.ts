import type { TraceEvent } from "./events.js";

// The project a run belongs to, derived from its events' `cwd`. One pure source
// (core has no node:path — it bundles to the browser too) reused by the optimizer
// (where to write CLAUDE.md), the rule loader, and baselines (which project's
// "usual run" to compare against). Picks the DOMINANT cwd — the dir most events
// ran in — so a transient first-event subdir doesn't win.

const isAbsolutePath = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? p;

export function dominantCwd(events: TraceEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const e of events) {
    const cwd = e.cwd;
    if (typeof cwd === "string" && cwd.length > 0 && isAbsolutePath(cwd)) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [cwd, n] of counts) {
    if (n > bestN) {
      best = cwd;
      bestN = n;
    }
  }
  return best;
}

// A short, stable key for the project (the dominant cwd's basename) — used to scope
// baselines so a run is only compared to your past runs of the same KIND in the
// same PROJECT, not mixed across every project a global daemon records.
export function projectKey(events: TraceEvent[]): string | null {
  const cwd = dominantCwd(events);
  return cwd ? baseName(cwd) : null;
}
