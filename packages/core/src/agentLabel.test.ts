import { describe, expect, it } from "vitest";

import { roleFromPrompt } from "./agentLabel.js";

describe("roleFromPrompt", () => {
  it("distils an English 'You are a <role>' declaration", () => {
    expect(roleFromPrompt("You are a literature-search specialist who finds papers.")).toBe("literature-search specialist");
    expect(roleFromPrompt("You're an adversarial reviewer that refutes claims.")).toBe("adversarial reviewer");
    expect(roleFromPrompt("You are co-authoring the report with the user.")).toBe("co-authoring the report");
  });

  it("strips a leading PREAMBLE — before the role", () => {
    expect(roleFromPrompt("PROJECT CONTEXT — You are a build engineer for the repo.")).toBe("build engineer");
  });

  it("distils a Korean '너는 <role>이다' / '<role>로서' declaration", () => {
    expect(roleFromPrompt("너는 내용 충실성 감사관이다. 아래 원문을 읽고 검증하라.")).toBe("내용 충실성 감사관");
    expect(roleFromPrompt("너는 한국어 번역 품질 검수자로서 자연스러움을 평가한다.")).toBe("한국어 번역 품질 검수자");
    expect(roleFromPrompt("너는 한국어 윤문가다.")).toBe("한국어 윤문가");
  });

  it("returns null when there's no role declaration (caller keeps its fallback)", () => {
    expect(roleFromPrompt("아래는 영어 학술 보고서의 한 섹션을 한국어로 번역한 결과다.")).toBeNull();
    expect(roleFromPrompt("general-purpose")).toBeNull();
    expect(roleFromPrompt("workflow:urp-report-korean")).toBeNull();
    expect(roleFromPrompt("")).toBeNull();
  });

  it("caps a long role so it fits the lane rail", () => {
    const role = roleFromPrompt("You are a senior staff distributed-systems reliability and observability engineer.");
    expect(role && role.length).toBeLessThanOrEqual(32);
  });
});
