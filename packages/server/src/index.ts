/**
 * UIClaw Server
 * 
 * Bridges the React frontend with the OpenClaw Gateway WebSocket.
 * Browser ↔ UIClaw WS ↔ OpenClaw Gateway WS (JSON-RPC)
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync, existsSync, createReadStream, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { GatewayClient } from "./gateway-client.js";
import { autoLayout, normalizeSpec, mergeSpecs, type UISpec } from "@uiclaw/ui-engine";

const PORT = parseInt(process.env.UICLAW_PORT ?? "3800", 10);
const HOST = process.env.UICLAW_HOST ?? "127.0.0.1";
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const REGISTRY_ROOT = "/Users/nicholashalstead/.openclaw/workspace/uiclaw-registry";
const REGISTRY_INDEX = join(REGISTRY_ROOT, "index.json");

// Per-browser-client state
interface ClientState {
  ws: WebSocket;
  gateway: GatewayClient;
  currentUi: UISpec | null;
  lastUserMessage: string | null;
}

const clients = new Map<string, ClientState>();

// ─── HTTP Server (static files) ──────────────────────────────
const httpServer = createServer((req, res) => {
  // ── API: Push UI specs from plugin tools ──
  if (req.method === "POST" && req.url === "/api/ui") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        // Transform local file paths to /files/ URLs so the browser can load them
        let spec = data.spec;
        if (spec) {
          const specStr = JSON.stringify(spec);
          const fixedStr = specStr.replace(/"(\/Users\/[^"]+)"/g, (_match: string, path: string) => {
            return `"/files${path}"`;
          });
          spec = JSON.parse(fixedStr);
        }
        const type = data.type ?? "ui.replace"; // ui.replace or ui.form
        console.log(`[API] /api/ui received: type=${type}, spec keys=${Object.keys(spec || {}).join(",")}`);
        // Push to ALL connected browser clients
        for (const [id, state] of clients) {
          const ready = state.ws.readyState === 1; // WebSocket.OPEN
          console.log(`[API] Sending to client ${id}, ws.readyState=${state.ws.readyState}, open=${ready}`);
          send(state.ws, { ...data, type, spec });
        }
        // Auto-register the interface
        if (type !== "ui.form" && spec && !data.skipRegister) {
          autoRegisterInterface(spec as UISpec, data.title || data.description || null);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, clients: clients.size }));
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── API: Registry index ──
  if (req.method === "GET" && req.url === "/api/registry") {
    try {
      const raw = readFileSync(REGISTRY_INDEX, "utf8");
      const data = JSON.parse(raw);
      const interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];
      const rewritten = interfaces.map((entry: any) => {
        if (!entry?.screenshotFile) return entry;
        const absPath = entry.screenshotFile.startsWith("/")
          ? entry.screenshotFile
          : join(REGISTRY_ROOT, entry.screenshotFile);
        return { ...entry, screenshotFile: `/files${absPath}` };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...data, interfaces: rewritten }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: Registry screenshot upload (from frontend html2canvas) ──
  if (req.method === "POST" && req.url === "/api/registry/screenshot") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { image } = JSON.parse(body);
        if (!image || !image.startsWith("data:image/png;base64,")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid image data" }));
          return;
        }
        const base64Data = image.replace(/^data:image\/png;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        
        // Find the most recently registered interface
        const indexPath = join(REGISTRY_ROOT, "index.json");
        if (!existsSync(indexPath)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No registry" }));
          return;
        }
        const index = JSON.parse(readFileSync(indexPath, "utf-8"));
        const latest = index.interfaces
          .filter((e: any) => !e.hasScreenshot)
          .sort((a: any, b: any) => new Date(b.created).getTime() - new Date(a.created).getTime())[0];
        
        if (!latest) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, skipped: true, reason: "all have screenshots" }));
          return;
        }
        
        const screenshotPath = join(REGISTRY_ROOT, latest.screenshotFile || `screenshots/${latest.id}.png`);
        mkdirSync(join(REGISTRY_ROOT, "screenshots"), { recursive: true });
        writeFileSync(screenshotPath, buffer);
        
        latest.hasScreenshot = true;
        writeFileSync(indexPath, JSON.stringify(index, null, 2));
        
        console.log(`[Registry] Screenshot saved for ${latest.id} (${latest.name})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: latest.id }));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Serve local files referenced by agents (images, etc.) ──
  if (req.method === "GET" && req.url?.startsWith("/files/")) {
    const filePath = decodeURIComponent(req.url.slice("/files".length)); // keeps leading /
    // Security: only allow files under workspace or media dirs
    const allowed = [
      "/Users/nicholashalstead/.openclaw/workspace/",
      "/Users/nicholashalstead/.openclaw/media/",
      "/Users/nicholashalstead/Projects/",
    ];
    const resolved = resolve(filePath);
    if (!allowed.some(p => resolved.startsWith(p)) || !existsSync(resolved)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
    const mimeTypes: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" });
    const stream = createReadStream(resolved);
    stream.pipe(res);
    return;
  }
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

// ─── Shared Gateway (single connection to OpenClaw) ──────────
let sharedGateway: GatewayClient | null = null;
let sharedState = {
  currentUi: null as any,
  lastUserMessage: null as string | null,
  gatewayConnected: false,
};

function initSharedGateway() {
  if (sharedGateway) return;
  sharedGateway = new GatewayClient({
    url: GATEWAY_URL,
    token: GATEWAY_TOKEN || undefined,
    onEvent: (event) => handleSharedGatewayEvent(event),
    onConnected: () => {
      sharedState.gatewayConnected = true;
      broadcast({ type: "gateway.connected" });
    },
    onDisconnected: (reason) => {
      sharedState.gatewayConnected = false;
      broadcast({ type: "gateway.disconnected", reason });
      // Reconnect after a delay
      setTimeout(() => { if (sharedGateway) sharedGateway.connect(); }, 2000);
    },
    onError: (error) => broadcast({ type: "error", message: error }),
  });
  sharedGateway.connect();
  console.log("[UIClaw] Shared gateway initialized");
}

function broadcast(msg: any) {
  for (const [id, state] of clients) {
    if (state.ws.readyState === 1) send(state.ws, msg);
  }
}

// ─── WebSocket Server ────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws) => {
  const clientId = `c_${Date.now().toString(36)}`;
  console.log(`[UIClaw] Client connected: ${clientId}`);

  // Initialize shared gateway on first client
  initSharedGateway();

  const state: ClientState = { ws, gateway: sharedGateway!, currentUi: sharedState.currentUi, lastUserMessage: sharedState.lastUserMessage };
  clients.set(clientId, state);

  // Send current state to new client
  if (sharedState.gatewayConnected) send(ws, { type: "gateway.connected" });
  if (sharedState.currentUi) send(ws, { type: "ui.update", spec: sharedState.currentUi, replace: true });

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
    clients.delete(clientId);
    // Don't close gateway — it's shared
  });
});

// ─── Client → Gateway ────────────────────────────────────────

function saveScreenshotFromBase64(dataUrl: string, _currentUi: any) {
  // Find the most recently modified interface file — that's what the browser just rendered
  const interfacesDir = join(REGISTRY_ROOT, "interfaces");
  try {
    const files = readdirSync(interfacesDir)
      .filter((f: string) => f.endsWith(".html"))
      .map((f: string) => ({ name: f, mtime: statSync(join(interfacesDir, f)).mtimeMs }))
      .sort((a: any, b: any) => b.mtime - a.mtime);
    if (files.length === 0) return;
    const id = files[0].name.replace(".html", "");
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const screenshotPath = join(REGISTRY_ROOT, "screenshots", id + ".png");
    mkdirSync(join(REGISTRY_ROOT, "screenshots"), { recursive: true });
    writeFileSync(screenshotPath, buffer);
    // Also update index.json with screenshot path
    const indexPath = join(REGISTRY_ROOT, "index.json");
    if (existsSync(indexPath)) {
      const idx = JSON.parse(readFileSync(indexPath, "utf-8"));
      const entry = (idx.interfaces || []).find((e: any) => e.id === id);
      if (entry) {
        entry.screenshotFile = "screenshots/" + id + ".png";
        writeFileSync(indexPath, JSON.stringify(idx, null, 2));
      }
    }
    console.log("[Registry] Screenshot saved for " + id + " (" + Math.round(buffer.length / 1024) + "KB)");
  } catch (e: any) {
    console.error("[Registry] Screenshot save error: " + e.message);
  }
}

async function handleClientMessage(clientId: string, state: ClientState, msg: any) {
  switch (msg.type) {
    case "chat.send": {
      const text = msg.text?.trim();
      if (!text) return;
      state.lastUserMessage = text;
      sharedState.lastUserMessage = text;
      try {
        const key = await sharedGateway!.sendMessage(text);
        send(state.ws, { type: "chat.ack", idempotencyKey: key });
      } catch (e: any) {
        send(state.ws, { type: "error", message: `Send failed: ${e.message}` });
      }
      break;
    }

    case "chat.abort": {
      try {
        await sharedGateway!.abort();
        send(state.ws, { type: "chat.aborted" });
      } catch (e: any) {
        send(state.ws, { type: "error", message: `Abort failed: ${e.message}` });
      }
      break;
    }

    case "ui.get": {
      send(state.ws, { type: "ui.update", spec: sharedState.currentUi, replace: true });
    autoRegisterInterface(sharedState.currentUi!, sharedState.lastUserMessage);
      break;
    }

    case "canvas.action": {
      const payload = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
      const actionType = msg.actionType ?? "action";
      // Screenshots go directly to registry — never into the agent session
      if (actionType === "screenshot-data" && typeof payload === "string" && payload.startsWith("data:image")) {
        console.log("[UIClaw] Screenshot received (" + Math.round(payload.length / 1024) + "KB) — saving to registry, NOT sending to agent");
        try {
          saveScreenshotFromBase64(payload, sharedState.currentUi);
        } catch (e: any) {
          console.error("[UIClaw] Screenshot save error: " + e.message);
        }
        break;
      }
      // All other canvas actions go to the agent
      const structured = `[CANVAS_ACTION type="${actionType}"]\n${payload}\n[/CANVAS_ACTION]`;
      try {
        console.log(`[UIClaw] Canvas action: type=${actionType}, payload=${payload.slice(0, 200)}`);
        await sharedGateway!.sendMessage(structured);
      } catch (e: any) {
        send(state.ws, { type: "error", message: `Canvas action failed: ${e.message}` });
      }
      break;
    }
  }
}

// ─── Gateway → Client ────────────────────────────────────────
function handleSharedGatewayEvent(event: any) {
  // Use sharedState for tracking, broadcast to all clients
  const state = sharedState;

  const eventType = event.event ?? "";
  const payload = event.payload ?? {};

  // Filter: only process events for the UIClaw session (ignore main/whatsapp/cron traffic)
  const eventSessionKey = payload.sessionKey ?? event.sessionKey ?? "";
  if (eventSessionKey && !eventSessionKey.includes("uiclaw")) {
    return; // Not our session, ignore
  }

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
        broadcast({
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
        broadcast({
          type: "chat.message",
          role: finalMsg.role ?? "assistant",
          content: text,
          timestamp: new Date().toISOString(),
          final: true,
        });

      }
      
      broadcast({ type: "chat.done", runId: payload.runId });
    }
    
    if (chatState === "error") {
      broadcast({ type: "chat.error", error: payload.errorMessage ?? "Unknown error" });
    }
  }

  // Chat history (from our own request)
  if (eventType === "chat.history") {
    const messages = payload.messages ?? event.messages ?? [];
    // If session is empty/new, reset context so system prompt gets re-sent
    if (messages.length === 0 && sharedGateway) {
      sharedGateway.resetContext();
    }
    broadcast({
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
    broadcast({ type: "agent.event", eventType, data: payload });
  }

  // UIClaw plugin events → workspace panel
  if (eventType === "uiclaw.ui.update") {
    const spec = normalizeSpec(payload.spec ?? payload);
    const replace = payload.replace ?? true;
    sharedState.currentUi = mergeSpecs(sharedState.currentUi, spec, replace);
    broadcast({ type: "ui.update", spec: sharedState.currentUi, replace: true });
    autoRegisterInterface(sharedState.currentUi!, sharedState.lastUserMessage);
  }

  if (eventType === "uiclaw.form.show") {
    broadcast({
      type: "form.show",
      formId: payload.formId,
      title: payload.title,
      description: payload.description,
      fields: payload.fields,
    });
  }

  // Forward everything else the frontend might want
  if (eventType === "sessions.list") {
    broadcast({ type: "sessions.list", sessions: payload.sessions ?? event.sessions ?? [] });
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

// ─── Auto-Registration ──────────────────────────────────────
import { createHash } from "crypto";

const REGISTRY_SPECS = join(REGISTRY_ROOT, "specs");
const REGISTRY_SCREENSHOTS = join(REGISTRY_ROOT, "screenshots");

function deriveNameFromIntent(intent: string): string {
  // Clean up the user's request into a concise interface name
  let name = intent
    .replace(/^(build|create|make|show|give|generate|render|design|can you|please|i want|i need)\s+(me\s+)?(a\s+|an\s+)?/i, "")
    .replace(/\s+(please|thanks|thank you|for me|asap)$/i, "")
    .trim();
  
  // Capitalize first letter of each word, limit length
  name = name
    .split(/\s+/)
    .slice(0, 6) // Max 6 words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  
  if (!name) return "Custom Interface";
  return name;
}

function deriveInterfaceName(spec: any): string {
  const type = (spec.type || "").toLowerCase();
  
  // Map component types to descriptive names
  const typeNames: Record<string, string> = {
    canvas: "Interactive Canvas",
    datatable: "Data Table",
    card: "Info Card",
    stack: "Layout Stack",
    markdown: "Content View",
    imagegrid: "Image Gallery",
    colorpalette: "Color Palette",
  };
  
  // Check for specific content patterns
  const str = JSON.stringify(spec).toLowerCase();
  if (str.includes("spreadsheet") || str.includes("cell") || str.includes("grid")) return "Spreadsheet Interface";
  if (str.includes("chart") || str.includes("graph")) return "Chart Visualization";
  if (str.includes("dashboard")) return "Dashboard";
  if (str.includes("form") || str.includes("input")) return "Form Interface";
  if (str.includes("kanban") || str.includes("board")) return "Kanban Board";
  if (str.includes("timeline") || str.includes("gantt")) return "Timeline View";
  if (str.includes("calendar")) return "Calendar View";
  if (str.includes("editor") || str.includes("code")) return "Code Editor";
  if (str.includes("map") || str.includes("geo")) return "Map View";
  if (str.includes("chat") || str.includes("message")) return "Chat Interface";
  if (str.includes("table") || str.includes("rows") || str.includes("columns")) return "Data Table";
  
  // Fall back to type name
  if (typeNames[type]) return typeNames[type];
  if (type) return type.charAt(0).toUpperCase() + type.slice(1) + " Interface";
  
  // Check children for clues
  if (spec.children && Array.isArray(spec.children)) {
    const childTypes = spec.children.map((c: any) => (c.type || "").toLowerCase());
    if (childTypes.includes("datatable")) return "Data Table Layout";
    if (childTypes.includes("card")) return "Card Layout";
    if (childTypes.includes("canvas")) return "Interactive Canvas Layout";
  }
  
  return "Custom Interface";
}

function deriveInterfaceDescription(spec: any): string {
  const name = deriveInterfaceName(spec);
  const str = JSON.stringify(spec).toLowerCase();
  const parts: string[] = [`${name}.`];
  
  // Count components
  const componentCount = (JSON.stringify(spec).match(/"type"/g) || []).length;
  if (componentCount > 1) parts.push(`${componentCount} components.`);
  
  // Note interactive features
  if (str.includes("onclick") || str.includes("button") || str.includes("click")) parts.push("Interactive.");
  if (str.includes("input") || str.includes("editable")) parts.push("Editable.");
  
  return parts.join(" ");
}

function autoRegisterInterface(spec: UISpec, userIntent?: string | null) {
  try {
    // Generate stable ID from spec content
    const specStr = JSON.stringify(spec, null, 2);
    const hash = createHash("sha256").update(specStr).digest("hex").slice(0, 12);
    const id = `ui_${hash}`;
    
    // Derive name and description from spec
    const name = userIntent ? deriveNameFromIntent(userIntent) : deriveInterfaceName(spec);
    const description = userIntent || deriveInterfaceDescription(spec);
    const tags = inferTags(spec);
    
    // Ensure dirs exist
    mkdirSync(REGISTRY_SPECS, { recursive: true });
    mkdirSync(REGISTRY_SCREENSHOTS, { recursive: true });
    
    // Save spec
    const specFile = `specs/${id}.json`;
    writeFileSync(join(REGISTRY_ROOT, specFile), specStr);
    
    // Update index
    const indexPath = join(REGISTRY_ROOT, "index.json");
    let index: any = { version: 1, interfaces: [] };
    if (existsSync(indexPath)) {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    }
    
    const existing = index.interfaces.findIndex((e: any) => e.id === id);
    const now = new Date().toISOString();
    const entry = {
      id,
      name,
      description,
      type: (spec as any).type || "render",
      tags,
      inputs: { description: "", schema: {} },
      outputs: { description: "", interactive: false },
      specFile,
      screenshotFile: `screenshots/${id}.png`,
      hasScreenshot: false,
      created: now,
      lastUsed: now,
      useCount: 1,
    };
    
    if (existing >= 0) {
      // Update existing — bump useCount and lastUsed
      index.interfaces[existing].useCount = (index.interfaces[existing].useCount || 0) + 1;
      index.interfaces[existing].lastUsed = now;
    } else {
      index.interfaces.push(entry);
    }
    
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log(`[Registry] Auto-registered: ${id} (${name})`);
    
    
  } catch (e: any) {
    console.error(`[Registry] Auto-register failed:`, e.message);
  }
}

function inferTags(spec: any): string[] {
  const tags: string[] = [];
  const str = JSON.stringify(spec).toLowerCase();
  if (str.includes("table") || str.includes("datatable") || str.includes("spreadsheet")) tags.push("table", "data");
  if (str.includes("card")) tags.push("card");
  if (str.includes("chart") || str.includes("graph")) tags.push("chart", "visualization");
  if (str.includes("form") || str.includes("input")) tags.push("form");
  if (str.includes("dashboard")) tags.push("dashboard");
  if (str.includes("status") || str.includes("health")) tags.push("status");
  if (str.includes("markdown")) tags.push("content");
  if (str.includes("canvas")) tags.push("canvas", "interactive");
  if (str.includes("image") || str.includes("gallery")) tags.push("media");
  if (tags.length === 0) tags.push("general");
  return [...new Set(tags)];
}

