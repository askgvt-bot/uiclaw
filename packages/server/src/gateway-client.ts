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
      scopes: ["operator.read", "operator.write"],
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

      // Fetch sessions list
      try {
        const sessions = await this.request("sessions.list", {});
        console.log("[Gateway] Sessions:", JSON.stringify(sessions).slice(0, 300));
        this.opts.onEvent({ type: "sessions.list", sessions: sessions?.sessions ?? [] });
      } catch (e: any) {
        console.log("[Gateway] Sessions list failed:", e.message);
      }

      // Fetch chat history for main session
      try {
        const history = await this.request("chat.history", {
          sessionKey: this.opts.sessionKey ?? "uiclaw",
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

  async sendMessage(text: string, sessionKey?: string): Promise<string> {
    const key = randomUUID().slice(0, 12);
    const sk = sessionKey ?? this.opts.sessionKey ?? "uiclaw";
    console.log(`[Gateway] chat.send → session=${sk}, key=${key}`);
    const result = await this.request("chat.send", {
      sessionKey: sk,
      message: text,
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
