/**
 * OpenClaw Gateway WebSocket Client
 * 
 * Protocol: JSON-RPC over WebSocket
 * - Request: { type: "req", id, method, params }
 * - Response: { type: "res", id, ok, payload|error }
 * - Event: { type: "event", event, payload }
 * 
 * Handshake: Gateway may send connect.challenge → Client sends connect request
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  sessionKey?: string;
  onEvent: (event: any) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onError: (error: string) => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private opts: GatewayClientOptions;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private authenticated = false;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  connect() {
    if (this.closed) return;
    this.authenticated = false;

    try {
      this.ws = new WebSocket(this.opts.url, {
        headers: { Origin: new URL(this.opts.url).origin },
      });
    } catch (e: any) {
      this.opts.onError(`Failed to connect: ${e.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("[Gateway] WebSocket opened, waiting for challenge...");
      // If no challenge within 2s, auth directly
      setTimeout(() => {
        if (!this.authenticated && this.ws?.readyState === WebSocket.OPEN) {
          console.log("[Gateway] No challenge, authenticating directly...");
          this.doAuth();
        }
      }, 2000);
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        
        // Handle connect challenge before auth
        if (!this.authenticated && msg.type === "event" && msg.event === "connect.challenge") {
          console.log("[Gateway] Got challenge, authenticating...");
          this.doAuth(msg.payload);
          return;
        }
        
        this.handleMessage(msg);
      } catch (e: any) {
        console.error("[Gateway] Bad message:", e.message);
      }
    });

    this.ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || `code ${code}`;
      console.log(`[Gateway] Disconnected: ${reasonStr}`);
      this.opts.onDisconnected(reasonStr);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      // Don't log ECONNREFUSED spam during reconnect
      if (!err.message.includes("ECONNREFUSED")) {
        console.error("[Gateway] Error:", err.message);
      }
      this.opts.onError(err.message);
    });
  }

  private async doAuth(challenge?: { nonce?: string; ts?: number }) {
    this.authenticated = true;
    
    const connectParams: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "0.1.0",
        platform: "web",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
      commands: [],
      permissions: {},
      locale: "en",
      userAgent: "UIClaw/0.1.0",
    };
    
    if (this.opts.token) {
      connectParams.auth = { token: this.opts.token };
    }

    try {
      const result = await this.request("connect", connectParams);
      console.log("[Gateway] Connected!", JSON.stringify(result).slice(0, 200));
      this.opts.onConnected();

      const sk = this.opts.sessionKey ?? "uiclaw";

      // Fetch chat history
      try {
        const history = await this.request("chat.history", {
          sessionKey: sk,
          limit: 50,
        });
        console.log("[Gateway] History:", JSON.stringify(history).slice(0, 300));
        this.opts.onEvent({ type: "chat.history", ...(history ?? {}) });
      } catch (e: any) {
        console.log("[Gateway] History fetch failed:", e.message);
      }
    } catch (e: any) {
      console.error("[Gateway] Auth failed:", e.message);
      this.opts.onError(`Auth: ${e.message}`);
    }
  }

  private handleMessage(msg: any) {
    if (msg.type === "res" && msg.id) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.ok === false || msg.error) {
          pending.reject(new Error(msg.error?.message ?? msg.error ?? JSON.stringify(msg)));
        } else {
          pending.resolve(msg.payload ?? msg.result ?? msg.data ?? msg);
        }
      }
    } else if (msg.type === "event") {
      this.opts.onEvent(msg);
    } else {
      // Forward anything else
      this.opts.onEvent(msg);
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway not connected");
    }

    const id = randomUUID().slice(0, 8);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30_000);
    });
  }

  private contextSent = false;
  private static CONTEXT = `[System: You are responding through UIClaw — a rich web UI at ui.gvtbot.net. The user sees a chat panel (left) and a workspace panel (right).

CRITICAL RULES:
1. Chat replies must be SHORT text only — never include HTML, code blocks, forms, or UI markup in chat.
2. ALL visual/structured content goes to the workspace panel via tools.
3. Before building anything new, call uiclaw_read(id="list") to check for existing interfaces. If one matches, use uiclaw_load(id) to render it instantly (zero cost).

Available tools:
- uiclaw_render: Push component trees (Stack, Card, DataTable, Canvas, ImageGrid, ColorPalette, Markdown, Form)
- uiclaw_canvas: Push custom HTML/CSS/JS — rendered in an iframe in the workspace (auto-saved to disk)
- uiclaw_load: Load a previously saved interface by ID — renders from disk, zero context cost
- uiclaw_read: List saved interfaces (id="list") or read code for editing (id="<id>")
- uiclaw_form: Show a form in the workspace and wait for user input

IMPORTANT — Canvas ↔ Agent data bridge:
When you use uiclaw_canvas, a global function sendToApp(type, data) is injected into the iframe. Use it in buttons/forms to send structured data back to you:
  sendToApp('research', {names: [{name:'John Smith', company:'Acme'}]})
This triggers a new agent turn with a [CANVAS_ACTION] block containing the data. The data NEVER appears in chat — it comes to you as structured input.

When you receive a [CANVAS_ACTION] message:
1. Parse the JSON payload
2. Do the work (web_search, etc.)
3. Push results back to the workspace using uiclaw_canvas or uiclaw_render — NOT chat
4. Only use chat for brief status updates like "Researching 5 people..."

Example canvas button:
  <button onclick="sendToApp('research', {names: collectNames()})">Research</button>

You do NOT need paired nodes or canvas workarounds — the web UI IS your render surface. Prefer uiclaw_form for simple data collection. Use uiclaw_canvas for rich interactive UI.]\n\n`;

  async sendMessage(text: string, sessionKey?: string): Promise<string> {
    const key = randomUUID().slice(0, 12);
    const sk = sessionKey ?? this.opts.sessionKey ?? "uiclaw";
    
    // Prepend context to first message only
    let message = text;
    if (!this.contextSent) {
      message = GatewayClient.CONTEXT + text;
      this.contextSent = true;
    }
    
    console.log(`[Gateway] chat.send → session=${sk}, key=${key}`);
    const result = await this.request("chat.send", {
      sessionKey: sk,
      message,
      deliver: false,
      idempotencyKey: key,
    });
    console.log(`[Gateway] chat.send result:`, JSON.stringify(result).slice(0, 200));
    return key;
  }

  async abort(sessionKey?: string): Promise<void> {
    await this.request("chat.abort", { sessionKey: sessionKey ?? this.opts.sessionKey ?? "main" });
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        console.log("[Gateway] Reconnecting...");
        this.connect();
      }
    }, 3000);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
  }
}
