export const AGENT_BLACKBOX_GJC_ADAPTER_VERSION = "0.1.0";

export function describeGjcAdapter(): string {
  return "Agent-Blackbox Gajae-Code adapter: session transcript-tailing capture layer.";
}

export { createGjcNormalizer } from "./normalize.js";
export { defaultGjcSessionsDir, startGjcTailer } from "./tailer.js";
export type {
  GjcNormalizerContext,
  GjcRecorderOptions,
  GjcTranscriptLine,
  TraceSink
} from "./types.js";
