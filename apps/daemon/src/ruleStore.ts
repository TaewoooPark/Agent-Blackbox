import { parseRulePack, type RulePack, type TraceEvent } from "@agent-blackbox/core";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Loads each project's optional rule pack from <project>/.agent-blackbox/rules.json.
// Returns a map keyed by project (the cwd basename) so the dashboard can pick the
// pack for the run it's VIEWING — not the one project that happens to dominate the
// whole event window. (A global daemon records many projects; shipping a single
// pack would apply project B's rules, or none, to a run in project A.) Cached with
// a short TTL + mtime check; best-effort — a missing/corrupt/oversized file is
// skipped and never throws.

type Cached = { pack: RulePack; checkedAt: number; mtimeMs: number };
const cache = new Map<string, Cached>();
const TTL_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const MAX_PROJECTS = 16; // bound how many distinct project dirs we stat per build
const EMPTY: RulePack = { rules: [] };

const isAbsolutePath = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);

async function loadOne(dir: string, now: number): Promise<RulePack> {
  const path = join(dir, ".agent-blackbox", "rules.json");
  const cached = cache.get(path);
  if (cached && now - cached.checkedAt < TTL_MS) return cached.pack;
  try {
    const st = await stat(path);
    if (cached && cached.mtimeMs === st.mtimeMs) {
      cached.checkedAt = now;
      return cached.pack;
    }
    if (st.size > MAX_BYTES) {
      cache.set(path, { pack: EMPTY, checkedAt: now, mtimeMs: st.mtimeMs });
      return EMPTY;
    }
    const pack = parseRulePack(JSON.parse(await readFile(path, "utf8")));
    cache.set(path, { pack, checkedAt: now, mtimeMs: st.mtimeMs });
    return pack;
  } catch {
    cache.set(path, { pack: EMPTY, checkedAt: now, mtimeMs: -1 });
    return EMPTY;
  }
}

// project key (cwd basename) → its rule pack, for every distinct project in the
// window that actually has rules. Empty projects are omitted to keep the map small.
export async function loadRulePacks(events: TraceEvent[], now = Date.now()): Promise<Record<string, RulePack>> {
  const cwds = new Set<string>();
  for (const e of events) {
    const cwd = e.cwd;
    if (typeof cwd === "string" && cwd.length > 0 && isAbsolutePath(cwd)) cwds.add(cwd);
    if (cwds.size >= MAX_PROJECTS) break;
  }
  const out: Record<string, RulePack> = {};
  for (const dir of cwds) {
    const pack = await loadOne(dir, now);
    if (pack.rules.length > 0) out[basename(dir)] = pack;
  }
  return out;
}

export function resetRuleCache(): void {
  cache.clear();
}
