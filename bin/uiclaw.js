#!/usr/bin/env node

/**
 * UIClaw CLI
 * 
 * Usage:
 *   uiclaw start [--port 3800] [--gateway ws://localhost:18789]
 *   uiclaw install  — Install UIClaw as an OpenClaw plugin
 */

const args = process.argv.slice(2);
const command = args[0] ?? "start";

if (command === "start") {
  // Start the server
  const port = getArg("--port") ?? "3800";
  const gateway = getArg("--gateway") ?? "ws://127.0.0.1:18789";
  const token = getArg("--token") ?? "";

  process.env.UICLAW_PORT = port;
  process.env.OPENCLAW_GATEWAY_URL = gateway;
  if (token) process.env.OPENCLAW_GATEWAY_TOKEN = token;

  import("../packages/server/src/index.ts");
} else if (command === "install") {
  console.log(`
  To install UIClaw as an OpenClaw plugin:

  1. Add to your OpenClaw config (~/.openclaw/openclaw.json):
     {
       "plugins": {
         "load": { "paths": ["${process.cwd()}/extensions/uiclaw"] }
       },
       "channels": {
         "uiclaw": { "accounts": { "default": { "enabled": true } } }
       }
     }

  2. Restart the OpenClaw gateway:
     openclaw gateway restart

  3. Start UIClaw:
     uiclaw start
  `);
} else {
  console.log("Usage: uiclaw [start|install]");
}

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
