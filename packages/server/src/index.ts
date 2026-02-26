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
    onConnected: () => send(ws, { type: "status", connected: true }),
    onDisconnected: (reason) => send(ws, { type: "status", connected: false, reason }),
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

  const eventType = event.type ?? event.event ?? "";

  // Chat events (agent responses)
  if (eventType === "chat" || eventType === "chat.message") {
    const entries = event.entries ?? event.messages ?? (event.text ? [{ role: "assistant", text: event.text }] : []);
    
    for (const entry of entries) {
      const text = entry.text ?? entry.content ?? "";
      const role = entry.role ?? "assistant";
      
      if (text && role === "assistant") {
        // Send chat message
        send(state.ws, {
          type: "chat.message",
          role,
          content: text,
          timestamp: entry.ts ?? new Date().toISOString(),
        });

        // Auto-generate UI from response
        const autoUi = autoLayout(text);
        if (autoUi) {
          state.currentUi = mergeSpecs(state.currentUi, autoUi, true);
          send(state.ws, { type: "ui.update", spec: state.currentUi, replace: true });
        }
      }
    }
  }

  // Chat history (initial load)
  if (eventType === "chat.history") {
    const messages = event.messages ?? [];
    send(state.ws, {
      type: "chat.history",
      entries: messages.map((m: any) => ({
        role: m.role ?? "system",
        content: m.text ?? m.content ?? "",
        timestamp: m.ts ?? "",
      })),
    });
  }

  // Agent events (tool calls, thinking, etc.)
  if (eventType.startsWith("agent.") || eventType.startsWith("tool.")) {
    send(state.ws, { type: "agent.event", eventType, data: event });
  }

  // UIClaw-specific events (from plugin tools)
  if (eventType === "uiclaw.ui.update") {
    const spec = normalizeSpec(event.spec ?? event.data?.spec);
    const replace = event.replace ?? event.data?.replace ?? true;
    state.currentUi = mergeSpecs(state.currentUi, spec, replace);
    send(state.ws, { type: "ui.update", spec: state.currentUi, replace: true });
  }

  if (eventType === "uiclaw.form.show") {
    send(state.ws, {
      type: "form.show",
      formId: event.formId ?? event.data?.formId,
      title: event.title ?? event.data?.title,
      description: event.description ?? event.data?.description,
      fields: event.fields ?? event.data?.fields,
    });
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
