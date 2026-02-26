/**
 * UIClaw Server
 * 
 * Bridges the React frontend with the OpenClaw Gateway WebSocket.
 * Browser ↔ UIClaw WS ↔ OpenClaw Gateway WS (JSON-RPC)
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { GatewayClient } from "./gateway-client.js";
import { autoLayout, normalizeSpec, mergeSpecs, type UISpec } from "@uiclaw/ui-engine";

const PORT = parseInt(process.env.UICLAW_PORT ?? "3800", 10);
const HOST = process.env.UICLAW_HOST ?? "127.0.0.1";
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

// Per-browser-client state
interface ClientState {
  ws: WebSocket;
  gateway: GatewayClient;
  currentUi: UISpec | null;
}

const clients = new Map<string, ClientState>();

// ─── HTTP Server (static files) ──────────────────────────────
const httpServer = createServer((req, res) => {
  const webDist = resolve(import.meta.dirname, "../../web/dist");
  
  if (!existsSync(webDist)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body style="background:#0f172a;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h1>✨ UIClaw</h1><p>Frontend not built. Run <code>pnpm build</code></p></div></body></html>`);
    return;
  }

  let filePath = join(webDist, req.url === "/" ? "index.html" : req.url!);
  if (!existsSync(filePath)) filePath = join(webDist, "index.html"); // SPA fallback

  try {
    const content = readFileSync(filePath);
    const ext = filePath.split(".").pop();
    const mimeTypes: Record<string, string> = {
      html: "text/html", js: "application/javascript", css: "text/css",
      png: "image/png", svg: "image/svg+xml", json: "application/json",
      woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext!] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// ─── WebSocket Server ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  const clientId = `c_${Date.now().toString(36)}`;
  console.log(`[UIClaw] Client connected: ${clientId}`);

  // Create a gateway connection for this client
  const gateway = new GatewayClient({
    url: GATEWAY_URL,
    token: GATEWAY_TOKEN || undefined,
    onEvent: (event) => handleGatewayEvent(clientId, event),
    onConnected: () => send(ws, { type: "gateway.connected" }),
    onDisconnected: (reason) => send(ws, { type: "gateway.disconnected", reason }),
    onError: (error) => send(ws, { type: "error", message: error }),
  });

  const state: ClientState = { ws, gateway, currentUi: null };
  clients.set(clientId, state);
  gateway.connect();

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleClientMessage(clientId, state, msg);
    } catch (e: any) {
      console.error(`[UIClaw] Bad client message:`, e.message);
    }
  });

  ws.on("close", () => {
    console.log(`[UIClaw] Client disconnected: ${clientId}`);
    gateway.close();
    clients.delete(clientId);
  });
});

// ─── Client → Gateway ────────────────────────────────────────
async function handleClientMessage(clientId: string, state: ClientState, msg: any) {
  switch (msg.type) {
    case "chat.send": {
      const text = msg.text?.trim();
      if (!text) return;
      try {
        const key = await state.gateway.sendMessage(text);
        send(state.ws, { type: "chat.ack", idempotencyKey: key });
      } catch (e: any) {
        send(state.ws, { type: "error", message: `Send failed: ${e.message}` });
      }
      break;
    }

    case "chat.abort": {
      try {
        await state.gateway.abort();
        send(state.ws, { type: "chat.aborted" });
      } catch (e: any) {
        send(state.ws, { type: "error", message: `Abort failed: ${e.message}` });
      }
      break;
    }

    case "ui.get": {
      send(state.ws, { type: "ui.update", spec: state.currentUi, replace: true });
      break;
    }
  }
}

// ─── Gateway → Client ────────────────────────────────────────
function handleGatewayEvent(clientId: string, event: any) {
  const state = clients.get(clientId);
  if (!state) return;

  const eventType = event.event ?? "";
  const payload = event.payload ?? {};
  // Full raw event for debugging
  if (eventType === "chat") {
    console.log(`[Event] chat FULL:`, JSON.stringify(event).slice(0, 1000));
  } else {
    console.log(`[Event] ${eventType}:`, JSON.stringify(payload).slice(0, 300));
  }

  // Chat events — the main agent response stream
  // Protocol: state="delta" with message={role, content/text}, then state="final"
  if (eventType === "chat") {
    const chatState = payload.state ?? "";
    const msg = payload.message ?? {};
    
    if (chatState === "delta" && msg) {
      // Extract text from message (can be string content or array of {type:"text", text})
      let text = "";
      if (typeof msg.text === "string") text = msg.text;
      else if (typeof msg.content === "string") text = msg.content;
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n");
      }
      
      const role = msg.role ?? "assistant";
      
      if (text) {
        send(state.ws, {
          type: "chat.delta",
          role,
          content: text,
          runId: payload.runId,
          seq: payload.seq,
        });
      }
    }
    
    if (chatState === "final") {
      // Final may also contain a message
      const finalMsg = payload.message ?? {};
      let text = "";
      if (typeof finalMsg.text === "string") text = finalMsg.text;
      else if (typeof finalMsg.content === "string") text = finalMsg.content;
      else if (Array.isArray(finalMsg.content)) {
        text = finalMsg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
      
      if (text) {
        send(state.ws, {
          type: "chat.message",
          role: finalMsg.role ?? "assistant",
          content: text,
          timestamp: new Date().toISOString(),
          final: true,
        });

      }
      
      send(state.ws, { type: "chat.done", runId: payload.runId });
    }
    
    if (chatState === "error") {
      send(state.ws, { type: "chat.error", error: payload.errorMessage ?? "Unknown error" });
    }
  }

  // Chat history (from our own request)
  if (eventType === "chat.history") {
    const messages = payload.messages ?? event.messages ?? [];
    send(state.ws, {
      type: "chat.history",
      entries: messages.map((m: any) => ({
        role: m.role ?? "system",
        content: m.text ?? m.content ?? "",
        timestamp: m.ts ?? "",
      })),
    });
  }

  // Agent lifecycle events (tool calls, thinking, etc.)
  if (eventType.startsWith("agent.") || eventType.startsWith("tool.")) {
    send(state.ws, { type: "agent.event", eventType, data: payload });
  }

  // UIClaw plugin events → workspace panel
  if (eventType === "uiclaw.ui.update") {
    const spec = normalizeSpec(payload.spec ?? payload);
    const replace = payload.replace ?? true;
    state.currentUi = mergeSpecs(state.currentUi, spec, replace);
    send(state.ws, { type: "ui.update", spec: state.currentUi, replace: true });
  }

  if (eventType === "uiclaw.form.show") {
    send(state.ws, {
      type: "form.show",
      formId: payload.formId,
      title: payload.title,
      description: payload.description,
      fields: payload.fields,
    });
  }

  // Forward everything else the frontend might want
  if (eventType === "sessions.list") {
    send(state.ws, { type: "sessions.list", sessions: payload.sessions ?? event.sessions ?? [] });
  }
}

function send(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Start ───────────────────────────────────────────────────
process.on("uncaughtException", (e) => console.error("[UIClaw] Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("[UIClaw] Unhandled:", e));

httpServer.listen(PORT, HOST, () => {
  console.log(`
  ✨ UIClaw v0.1.0

  Web UI:   http://${HOST}:${PORT}
  Gateway:  ${GATEWAY_URL}
  Auth:     ${GATEWAY_TOKEN ? "token ✓" : "none (loopback)"}
`);
});
