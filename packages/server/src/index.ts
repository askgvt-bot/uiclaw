/**
 * UIClaw Server
 * 
 * Bridges the React frontend with the OpenClaw Gateway WebSocket.
 * 
 * Browser ↔ UIClaw WS ↔ OpenClaw Gateway WS
 * 
 * Also serves the built frontend via static files.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { autoLayout, normalizeSpec, mergeSpecs, type UISpec } from "@uiclaw/ui-engine";

const PORT = parseInt(process.env.UICLAW_PORT ?? "3800", 10);
const HOST = process.env.UICLAW_HOST ?? "127.0.0.1";
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";

// Per-client state
interface ClientState {
  ws: WebSocket;
  gatewayWs: WebSocket | null;
  sessionKey: string | null;
  currentUi: UISpec | null;
  chatHistory: Array<{ role: string; content: string; timestamp: string }>;
}

const clients = new Map<string, ClientState>();

// HTTP server for static files + WebSocket upgrade
const httpServer = createServer((req, res) => {
  // Serve static frontend files
  const webDist = resolve(import.meta.dirname, "../../web/dist");
  
  if (!existsSync(webDist)) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>UIClaw</h1><p>Frontend not built yet. Run <code>pnpm build</code></p>");
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
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext!] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

// WebSocket server for browser clients
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state: ClientState = {
    ws,
    gatewayWs: null,
    sessionKey: null,
    currentUi: null,
    chatHistory: [],
  };
  clients.set(clientId, state);

  console.log(`[UIClaw] Client connected: ${clientId}`);

  // Connect to OpenClaw Gateway
  connectToGateway(clientId, state);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleClientMessage(clientId, state, msg);
    } catch (e) {
      console.error(`[UIClaw] Bad message from ${clientId}:`, e);
    }
  });

  ws.on("close", () => {
    console.log(`[UIClaw] Client disconnected: ${clientId}`);
    state.gatewayWs?.close();
    clients.delete(clientId);
  });
});

function connectToGateway(clientId: string, state: ClientState) {
  const params: Record<string, string> = {};
  if (GATEWAY_TOKEN) params["auth.token"] = GATEWAY_TOKEN;

  const url = new URL(GATEWAY_URL);
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    searchParams.set(k, v);
  }
  url.search = searchParams.toString();

  const gw = new WebSocket(url.toString());
  state.gatewayWs = gw;

  gw.on("open", () => {
    console.log(`[UIClaw] Gateway connected for ${clientId}`);
    send(state.ws, { type: "gateway.connected" });
    
    // Request chat history
    sendToGateway(gw, "chat.history", {});
  });

  gw.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleGatewayMessage(clientId, state, msg);
    } catch (e) {
      console.error(`[UIClaw] Bad gateway message:`, e);
    }
  });

  gw.on("close", () => {
    console.log(`[UIClaw] Gateway disconnected for ${clientId}`);
    send(state.ws, { type: "gateway.disconnected" });
  });

  gw.on("error", (err) => {
    console.error(`[UIClaw] Gateway error for ${clientId}:`, err.message);
    send(state.ws, { type: "gateway.error", error: err.message });
  });
}

function handleClientMessage(clientId: string, state: ClientState, msg: any) {
  switch (msg.type) {
    case "chat.send": {
      // User sends a message → forward to gateway
      const text = msg.text?.trim();
      if (!text || !state.gatewayWs) return;
      
      // Add to local history
      state.chatHistory.push({
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      });
      
      sendToGateway(state.gatewayWs, "chat.send", {
        text,
        channel: "uiclaw",
      });
      break;
    }

    case "form.submit": {
      // User submits a form → forward via gateway RPC
      if (!state.gatewayWs) return;
      sendToGateway(state.gatewayWs, "uiclaw.form.submit", {
        chatId: msg.chatId,
        formId: msg.formId,
        values: msg.values,
      });
      break;
    }

    case "ui.get": {
      // Client requests current UI state
      send(state.ws, {
        type: "ui.update",
        spec: state.currentUi,
        replace: true,
      });
      break;
    }
  }
}

function handleGatewayMessage(clientId: string, state: ClientState, msg: any) {
  // Handle different gateway event types
  const type = msg.type ?? msg.method ?? msg.event;

  switch (type) {
    case "chat": {
      // Agent response
      const text = msg.text ?? msg.data?.text ?? "";
      if (text) {
        state.chatHistory.push({
          role: "assistant",
          content: text,
          timestamp: new Date().toISOString(),
        });
        
        // Run through UI engine for auto-layout
        const autoUi = autoLayout(text, msg.toolResults);
        if (autoUi) {
          state.currentUi = mergeSpecs(state.currentUi, autoUi, true);
          send(state.ws, { type: "ui.update", spec: state.currentUi, replace: true });
        }
        
        // Forward chat message
        send(state.ws, { type: "chat.message", role: "assistant", content: text, timestamp: new Date().toISOString() });
      }
      break;
    }

    case "chat.history": {
      // Initial history load
      const entries = msg.data?.entries ?? msg.entries ?? [];
      send(state.ws, { type: "chat.history", entries });
      break;
    }

    case "uiclaw.ui.update": {
      // Explicit UI update from agent tool
      const spec = normalizeSpec(msg.data?.spec ?? msg.spec);
      const replace = msg.data?.replace ?? msg.replace ?? true;
      state.currentUi = mergeSpecs(state.currentUi, spec, replace);
      send(state.ws, { type: "ui.update", spec: state.currentUi, replace: true });
      break;
    }

    case "uiclaw.form.show": {
      // Agent wants to show a form
      send(state.ws, {
        type: "form.show",
        formId: msg.data?.formId ?? msg.formId,
        title: msg.data?.title ?? msg.title,
        description: msg.data?.description ?? msg.description,
        fields: msg.data?.fields ?? msg.fields,
      });
      break;
    }

    case "uiclaw.agent.message": {
      // Outbound channel delivery
      const text = msg.data?.text ?? msg.text;
      if (text) {
        send(state.ws, { type: "chat.message", role: "assistant", content: text, timestamp: new Date().toISOString() });
      }
      break;
    }

    default: {
      // Forward unknown events for transparency
      if (msg.type?.startsWith("tool.") || msg.type?.startsWith("agent.")) {
        send(state.ws, { type: "agent.event", event: msg });
      }
      break;
    }
  }
}

function send(ws: WebSocket, data: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendToGateway(gw: WebSocket, method: string, params: any) {
  send(gw, {
    type: "rpc",
    id: `rpc_${Date.now()}`,
    method,
    params,
  });
}

// Start
httpServer.listen(PORT, HOST, () => {
  console.log(`\n  ✨ UIClaw running at http://${HOST}:${PORT}\n`);
  console.log(`  Gateway: ${GATEWAY_URL}`);
  console.log(`  Auth: ${GATEWAY_TOKEN ? "token configured" : "no token (loopback only)"}\n`);
});
