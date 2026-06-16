#!/usr/bin/env node
import { AGENT_BLACKBOX_DAEMON_VERSION, describeDaemon } from "./index.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(AGENT_BLACKBOX_DAEMON_VERSION);
} else {
  console.log(describeDaemon());
  console.log("Commands are scaffolded. Next: daemon, replay, dashboard, init-opencode.");
}

