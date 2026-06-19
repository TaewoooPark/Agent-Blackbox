import { describe, expect, it } from "vitest";

import { computeEfficiencyReport } from "./efficiency.js";
import { createTraceEvent } from "./events.js";
import {
  buildEfficiencyMemory,
  EFFICIENCY_MEMORY_END,
  EFFICIENCY_MEMORY_START,
  removeManagedBlock,
  upsertManagedBlock
} from "./efficiencyMemory.js";

const ev = (seq: number, kind: Parameters<typeof createTraceEvent>[1]["kind"], payload: Record<string, unknown>) =>
  createTraceEvent(seq, { host: "opencode", runId: "r", sessionId: "s", kind, payload: payload as never });

const wastefulReport = () =>
  computeEfficiencyReport([
    ev(1, "file_read", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }),
    ev(2, "file_read", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 80_000 }),
    ev(3, "file_edit", { source: "tool.after", path: "$PROJECT/src/calc.ts", chars: 100 })
  ]);

describe("efficiency memory", () => {
  it("builds a terse block naming the offenders, or null when clean", () => {
    const block = buildEfficiencyMemory(wastefulReport(), { verifiedCommands: ["node test.js"] });
    expect(block).not.toBeNull();
    expect(block).toContain(EFFICIENCY_MEMORY_START);
    expect(block).toContain(EFFICIENCY_MEMORY_END);
    expect(block).toContain("calc.ts"); // the re-read offender is named
    expect(block).toContain("node test.js"); // verified command is pinned
    // a clean run yields nothing to pin
    const clean = computeEfficiencyReport([ev(1, "file_edit", { source: "tool.after", path: "$PROJECT/a.ts", chars: 100 })]);
    expect(buildEfficiencyMemory(clean)).toBeNull();
  });

  it("appends at the end and is idempotent — the stable prefix is preserved", () => {
    const block = buildEfficiencyMemory(wastefulReport())!;
    const original = "# My Project\n\nStable instructions the prompt cache depends on.\n";
    const once = upsertManagedBlock(original, block);
    expect(once.startsWith(original.trimEnd())).toBe(true); // prefix untouched → cache-safe
    expect(once.indexOf(EFFICIENCY_MEMORY_START)).toBeGreaterThan(once.indexOf("Stable instructions"));

    // re-applying replaces in place rather than stacking duplicates
    const twice = upsertManagedBlock(once, block);
    expect(twice.split(EFFICIENCY_MEMORY_START).length - 1).toBe(1);
  });

  it("reverts cleanly back to the original content", () => {
    const block = buildEfficiencyMemory(wastefulReport())!;
    const original = "# My Project\n\nStable instructions.\n";
    const applied = upsertManagedBlock(original, block);
    expect(removeManagedBlock(applied)).toBe(original);
  });
});
