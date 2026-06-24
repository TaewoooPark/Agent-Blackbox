import { describe, expect, it } from "vitest";

import { fileNameFromPath, normalizedProjectPath, pathSegments } from "./filePath.js";

describe("file path segmentation", () => {
  it("segments a POSIX $PROJECT path", () => {
    expect(pathSegments("$PROJECT/src/foo.ts")).toEqual(["src", "foo.ts"]);
    expect(fileNameFromPath("$PROJECT/src/foo.ts")).toBe("foo.ts");
  });

  it("segments a Windows-separator $PROJECT path the SAME way (regression: was one mangled chunk)", () => {
    expect(pathSegments("$PROJECT\\src\\foo.ts")).toEqual(["src", "foo.ts"]);
    expect(fileNameFromPath("$PROJECT\\src\\foo.ts")).toBe("foo.ts");
  });

  it("segments a Windows absolute path (drive letter, backslashes)", () => {
    expect(pathSegments("C:\\Users\\x\\proj\\src\\foo.ts")).toEqual(["C:", "Users", "x", "proj", "src", "foo.ts"]);
    expect(fileNameFromPath("C:\\Users\\x\\proj\\src\\foo.ts")).toBe("foo.ts");
  });

  it("strips the $PROJECT prefix and any leading slash", () => {
    expect(normalizedProjectPath("$PROJECT/a.ts")).toBe("a.ts");
    expect(normalizedProjectPath("$PROJECT\\a.ts")).toBe("a.ts");
    expect(normalizedProjectPath("/a/b.ts")).toBe("a/b.ts");
  });

  it("handles a bare filename and empties", () => {
    expect(pathSegments("README.md")).toEqual(["README.md"]);
    expect(pathSegments("")).toEqual([]);
    expect(fileNameFromPath("README.md")).toBe("README.md");
  });
});
