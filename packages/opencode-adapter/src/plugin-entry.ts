import { createOpenCodePlugin } from "./index.js";

// esbuild bundles this into a single self-contained plugin file (only AgentBlackbox
// is exported; createOpenCodePlugin + the whole adapter are inlined). The npx CLI's
// init writes it into a project's .opencode/plugins/ with __ABB_DAEMON_URL__ replaced
// by the running daemon's URL — so OpenCode loads the recorder with zero install.
// In-run optimization stays env-driven via AGENT_BLACKBOX_OPTIMIZE=1.
export const AgentBlackbox = createOpenCodePlugin({
  daemonUrl: process.env.AGENT_BLACKBOX_DAEMON_URL ?? "__ABB_DAEMON_URL__"
});
