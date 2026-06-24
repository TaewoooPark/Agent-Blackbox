import { dominantCwd, parseRulePack, type RulePack, type TraceEvent } from "@agent-blackbox/core";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Loads a project's optional rule pack from <project>/.agent-blackbox/rules.json,
// resolving <project> from the run's dominant cwd (the same dir the optimizer
// writes CLAUDE.md to). Cached with a short TTL + mtime check; best-effort — a
// missing/corrupt/oversized file yields an empty pack and never throws. The parsed
// pack rides in the snapshot; the dashboard evaluates it against the viewed run.

type Cached = { pack: RulePack; checkedAt: number; mtimeMs: number };
const cache = new Map<string, Cached>();
const TTL_MS = 10_000;
const MAX_BYTES = 64 * 1024;
const EMPTY: RulePack = { rules: [] };

export async function loadRulePack(events: TraceEvent[], now = Date.now()): Promise<RulePack> {
  const dir = dominantCwd(events);
  if (!dir) return EMPTY;
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

export function resetRuleCache(): void {
  cache.clear();
}
