// Distil a concise agent role from a verbose task prompt, for the lane rail. The
// best lane label is the agent's role/type (from the spawn: subagent_type /
// workflow:<name>). When only the subagent's own transcript exists, all we have is
// its first prompt — and those almost always open with a role declaration ("You are
// a literature-search specialist", "너는 내용 충실성 감사관이다"). Pull that role out
// so a 60-lane workflow reads as roles, not paragraphs. Pure + deterministic, so it
// can run both in the adapter (new recordings) and at render time (already-stored
// runs). Returns null when no clear role is present (caller keeps its fallback).

const MAX_ROLE = 32;

const cap = (role: string): string => {
  const r = role.replace(/\s+/g, " ").trim();
  return r.length > MAX_ROLE ? `${r.slice(0, MAX_ROLE - 1).trimEnd()}…` : r;
};

// Trim an English role to its head noun phrase: stop at a relative/continuation
// clause ("X who…", "X that…", "X and…", "X to…") and drop a leading article.
const trimEnglishRole = (raw: string): string => {
  let r = raw.replace(/\s+(?:who|that|whose|which|and|but|or|to|for|so|with|on|using|from|—|-)\b.*$/i, "").trim();
  r = r.replace(/^an?\s+/i, "");
  return r;
};

export function roleFromPrompt(text: string): string | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (s.length === 0) return null;
  // Drop a leading "PREAMBLE — " / "PREAMBLE: " label to reach the role declaration.
  const sep = s.search(/\s[—:-]\s/);
  if (sep > 0 && sep < 30) s = s.slice(sep + 3).trim();

  // English: "You are [a|an] <role>", up to sentence punctuation.
  const en = s.match(/^you(?:'re| are)\s+([^.;:\n]{3,60})/i);
  if (en && en[1]) {
    const role = trimEnglishRole(en[1]);
    if (role.length >= 3) return cap(role);
  }

  // Korean "너는 <role>로서 …한다" — the role is the part before the "as a" marker.
  const koAs = s.match(/^너는\s+([\s\S]{2,40}?)(?:으로서|로서)[\s,]/);
  if (koAs && koAs[1] && koAs[1].trim().length >= 2) return cap(koAs[1].trim());

  // Korean: "너는 <role>(이)다/입니다…" — require a copula so we capture a real role.
  const ko = s.match(/^너는\s+([\s\S]{2,40}?)(?:이다|이야|입니다|이에요|예요|이라고|다)[.\s,]/);
  if (ko && ko[1]) {
    const role = ko[1].replace(/\s+(?:으로서|로서)$/, "").trim();
    if (role.length >= 2) return cap(role);
  }

  return null;
}
