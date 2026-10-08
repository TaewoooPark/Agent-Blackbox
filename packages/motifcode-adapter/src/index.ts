export const AGENT_BLACKBOX_MOTIFCODE_ADAPTER_VERSION = "0.1.0";

export function describeMotifcodeAdapter(): string {
  return "Agent-Blackbox Motifcode adapter: local v2 journal capture layer.";
}

export { createMotifcodeNormalizer } from "./normalize.js";
export { defaultMotifcodeSessionsDir, startMotifcodeTailer } from "./tailer.js";
export type { MotifcodeJournalLine, MotifcodeNormalizerContext, MotifcodeRecorderOptions, TraceSink } from "./types.js";
