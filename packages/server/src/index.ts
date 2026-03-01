/**
 * UIClaw Server
 * 
 * Bridges the React frontend with the OpenClaw Gateway WebSocket.
 * Browser ↔ UIClaw WS ↔ OpenClaw Gateway WS (JSON-RPC)
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync, existsSync, createReadStream, writeFileSync, mkdirSync } from "fs";
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
        const specStr = JSON.stringify(data.spec);
        const fixedStr = specStr.replace(/"(\/Users\/[^"]+)"/g, (_match, path) => {
          return `"/files${path}"`;
        });
        const spec = JSON.parse(fixedStr);
        const type = data.type ?? "ui.replace"; // ui.replace or ui.form
        console.log(`[API] /api/ui received: type=${type}, spec keys=${Object.keys(spec || {}).join(",")}`);
        // Push to ALL connected browser clients
        for (const [id, state] of clients) {
          const ready = state.ws.readyState === 1; // WebSocket.OPEN
          console.log(`[API] Sending to client ${id}, ws.readyState=${state.ws.readyState}, open=${ready}`);
          send(state.ws, { ...data, type, spec });
        }
        // Auto-register the interface
        if (type !== "ui.form" && spec) {
          autoRegisterInterface(spec as UISpec);
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
    autoRegisterInterface(state.currentUi!);
      break;
    }

    case "canvas.action": {
      // Structured data from Canvas iframe — forward to agent without polluting chat
      const payload = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
      const actionType = msg.actionType ?? "action";
      // Send as a hidden structured message — agent sees it, chat doesn't display it
      const structured = `[CANVAS_ACTION type="${actionType}"]\n${payload}\n[/CANVAS_ACTION]`;
      try {
        console.log(`[UIClaw] Canvas action: type=${actionType}, payload=${payload.slice(0, 200)}`);
        await state.gateway.sendMessage(structured);
      } catch (e: any) {
        send(state.ws, { type: "error", message: `Canvas action failed: ${e.message}` });
      }
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
    autoRegisterInterface(state.currentUi!);
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

// ─── Auto-Registration ──────────────────────────────────────
import { createHash } from "crypto";
import { execFile } from "child_process";

const REGISTRY_SPECS = join(REGISTRY_ROOT, "specs");
const REGISTRY_SCREENSHOTS = join(REGISTRY_ROOT, "screenshots");

function autoRegisterInterface(spec: UISpec) {
  try {
    // Generate stable ID from spec content
    const specStr = JSON.stringify(spec, null, 2);
    const hash = createHash("sha256").update(specStr).digest("hex").slice(0, 12);
    const id = `ui_${hash}`;
    
    // Derive name and description from spec
    const name = (spec as any).title || (spec as any).name || (spec as any).type || "Untitled Interface";
    const description = (spec as any).description || `Auto-registered ${(spec as any).type || "interface"}`;
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
    
    // Async: capture screenshot via Playwright
    captureScreenshot(id, spec);
    
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

function captureScreenshot(id: string, _spec: UISpec) {
  const screenshotPath = join(REGISTRY_SCREENSHOTS, `${id}.png`);
  const url = `http://${HOST}:${PORT}`;
  
  // Use Playwright to screenshot the current rendered UI
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto('${url}');
      await page.waitForTimeout(2000);
      // Screenshot just the workspace panel (right side)
      const workspace = await page.$('.flex-1.flex.flex-col.overflow-hidden.relative');
      if (workspace) {
        await workspace.screenshot({ path: '${screenshotPath}' });
      } else {
        await page.screenshot({ path: '${screenshotPath}' });
      }
      await browser.close();
    })();
  `;
  
  execFile("node", ["-e", script], { timeout: 15000 }, (err) => {
    if (err) {
      console.error(`[Registry] Screenshot failed for ${id}:`, err.message);
      return;
    }
    // Update hasScreenshot in index
    try {
      const indexPath = join(REGISTRY_ROOT, "index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      const entry = index.interfaces.find((e: any) => e.id === id);
      if (entry) {
        entry.hasScreenshot = true;
        writeFileSync(indexPath, JSON.stringify(index, null, 2));
      }
      console.log(`[Registry] Screenshot captured: ${id}`);
    } catch {}
  });
}
