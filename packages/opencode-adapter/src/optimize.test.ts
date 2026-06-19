import { describe, expect, it } from "vitest";

import {
  buildWorkingSetBlock,
  computeReadDelta,
  decideReadServe,
  hashContent,
  isReadTool,
  isReusableCommand,
  readArgPath,
  WORKING_SET_END,
  WORKING_SET_START
} from "./optimize.js";

const entry = (content: string, gen: number) => ({ hash: hashContent(content), content, gen });

describe("in-run optimizer", () => {
  it("serves the full file on first read", () => {
    const cur = "line1\nline2\n";
    const d = decideReadServe(undefined, { hash: hashContent(cur), content: cur }, 0, "a.ts");
    expect(d.mode).toBe("full");
  });

  it("serves a no-op when an unchanged file is re-read with no compaction since", () => {
    const cur = "a\nb\nc\n".repeat(50);
    const prior = entry(cur, 0);
    const d = decideReadServe(prior, { hash: hashContent(cur), content: cur }, 0, "big.ts");
    expect(d.mode).toBe("noop");
    expect(d.output).toMatch(/unchanged/i);
    expect(d.saved).toBeGreaterThan(0); // the note is far smaller than the file
  });

  it("serves the full file again after a compaction (the agent may have lost it)", () => {
    const cur = "a\nb\nc\n".repeat(50);
    const prior = entry(cur, 0);
    // gen advanced → compaction happened since we last served it
    const d = decideReadServe(prior, { hash: hashContent(cur), content: cur }, 1, "big.ts");
    expect(d.mode).toBe("full");
  });

  it("serves only the changed slice when an edited file is re-read", () => {
    const prior = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const current = prior.replace("line 30", "line 30 // edited");
    const d = decideReadServe(entry(prior, 0), { hash: hashContent(current), content: current }, 0, "src/x.ts");
    expect(d.mode).toBe("diff");
    expect(d.output).toContain("line 30 // edited");
    expect(d.output).not.toContain("line 5"); // unchanged lines are omitted
    expect((d.output ?? "").length).toBeLessThan(current.length);
  });

  it("computeReadDelta returns null when content is identical", () => {
    expect(computeReadDelta("x\ny", "x\ny", "a.ts")).toBeNull();
  });

  it("builds a working-set block from hot files and reusable commands", () => {
    const block = buildWorkingSetBlock(
      [
        { path: "src/calc.ts", reads: 3, edits: 1 },
        { path: "src/util.ts", reads: 1, edits: 0 }
      ],
      ["node test.js", "node test.js"]
    );
    expect(block).toContain(WORKING_SET_START);
    expect(block).toContain(WORKING_SET_END);
    expect(block).toContain("src/calc.ts");
    expect(block).toContain("node test.js");
    expect(buildWorkingSetBlock([], [])).toBeNull();
  });

  it("recognizes read tools, command paths, and reusable vs navigation commands", () => {
    expect(isReadTool("read")).toBe(true);
    expect(isReadTool("bash")).toBe(false);
    expect(readArgPath({ filePath: "a.ts" })).toBe("a.ts");
    expect(readArgPath({ path: "b.ts" })).toBe("b.ts");
    expect(isReusableCommand("node test.js")).toBe(true);
    expect(isReusableCommand("ls -la")).toBe(false);
  });
});
