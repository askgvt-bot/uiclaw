/**
 * UIClaw — OpenClaw Plugin
 *
 * Context optimization: HTML/specs are saved to disk and only a summary
 * is returned to the agent context. Use uiclaw_read to recall code when
 * modifying an existing interface.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const UICLAW_URL = process.env.UICLAW_URL ?? "http://127.0.0.1:3800";
const INTERFACES_DIR = join(
  process.env.HOME ?? "/tmp",
  ".openclaw/workspace/uiclaw-registry/interfaces"
);

mkdirSync(INTERFACES_DIR, { recursive: true });

function saveInterface(html: string, title?: string): { id: string; path: string; lines: number } {
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 12);
  const id = "ui_" + hash;
  const filepath = join(INTERFACES_DIR, id + ".html");
  writeFileSync(filepath, html);
  // Update index.json so names are available for listing
  try {
    var indexPath = join(INTERFACES_DIR, "..", "index.json");
    var idx: any = { interfaces: [] };
    if (existsSync(indexPath)) idx = JSON.parse(readFileSync(indexPath, "utf-8"));
    var found = false;
    for (var e of (idx.interfaces || [])) { if (e.id === id) { found = true; break; } }
    if (!found) {
      idx.interfaces = idx.interfaces || [];
      idx.interfaces.push({ id: id, name: title || "untitled", savedAt: new Date().toISOString() });
      writeFileSync(indexPath, JSON.stringify(idx, null, 2));
    }
  } catch {}
  return { id, path: filepath, lines: html.split("\n").length };
}
function loadInterface(id: string): string | null {
  const filepath = join(INTERFACES_DIR, id + ".html");
  if (existsSync(filepath)) return readFileSync(filepath, "utf-8");
  const filepath2 = join(INTERFACES_DIR, "ui_" + id + ".html");
  if (existsSync(filepath2)) return readFileSync(filepath2, "utf-8");
  return null;
}

function listInterfaces(): { id: string; name: string; lines: number; sizeKb: number }[] {
  try {
    // Read names from registry index.json
    var names: Record<string, string> = {};
    var indexPath = join(INTERFACES_DIR, "..", "index.json");
    if (existsSync(indexPath)) {
      var index = JSON.parse(readFileSync(indexPath, "utf-8"));
      for (var entry of (index.interfaces || [])) {
        if (entry.id && entry.name) names[entry.id] = entry.name;
      }
    }
    return readdirSync(INTERFACES_DIR).filter(function(f) { return f.endsWith(".html"); }).map(function(f) {
      var fp = join(INTERFACES_DIR, f);
      var id = f.replace(".html", "");
      var c = readFileSync(fp, "utf-8");
      return { id: id, name: names[id] || "unnamed", lines: c.split("\n").length, sizeKb: Math.round(statSync(fp).size / 1024) };
    });
  } catch { return []; }
}

async function pushToUIClaw(data: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(UICLAW_URL + "/api/ui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    console.log("[UIClaw Plugin] Push: " + res.status + " " + body.slice(0, 200));
  } catch (e: any) {
    console.error("[UIClaw Plugin] Push error: " + e.message);
  }
}

const uiSessions = new Map<string, { currentUi: any; pendingForms: Map<string, { resolve: (v: any) => void }> }>();

function getSession(id: string) {
  if (!uiSessions.has(id)) uiSessions.set(id, { currentUi: null, pendingForms: new Map() });
  return uiSessions.get(id)!;
}

export default function register(api: any) {
  const log = api.logger ?? console;

  // ── uiclaw_render ──
  api.registerTool({
    name: "uiclaw_render",
    description: "Push a rich UI layout to the UIClaw web workspace panel.\n\nComponent types: Stack, Markdown, Card, DataTable, Canvas, ImageGrid, ColorPalette.\n\nExample: { \"type\": \"Stack\", \"children\": [{ \"type\": \"Card\", \"title\": \"Revenue\", \"icon\": \"\ud83d\udcb0\", \"content\": \"$2.3M\" }] }",
    parameters: {
      type: "object",
      properties: {
        spec: { type: "object", description: "UI component tree" },
        replace: { type: "boolean", description: "Replace current UI (default true)" },
      },
      required: ["spec"],
    },
    async execute(_ctx: any, params: { spec: any; replace?: boolean }) {
      var chatId = typeof _ctx === "string" ? _ctx : (_ctx?.sessionKey ?? "default");
      getSession(chatId).currentUi = params.spec;
      await pushToUIClaw({ type: "ui.replace", spec: params.spec, replace: params.replace ?? true });
      return { content: [{ type: "text", text: "UI rendered (" + countNodes(params.spec) + " components)" }] };
    },
  });

  // ── uiclaw_canvas ──
  api.registerTool({
    name: "uiclaw_canvas",
    description: "Render custom HTML/CSS/JS in the UIClaw workspace. HTML is auto-saved to disk \u2014 only a summary stays in context.\n\nTo modify an existing interface: call uiclaw_read(id) first, edit the code, then render again.",
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML content to render" },
        height: { type: "number", description: "Height in pixels (default 400)" },
        title: { type: "string", description: "Canvas title" },
      },
      required: ["html"],
    },
    async execute(_ctx: any, params: { html: string; height?: number; title?: string }) {
      var saved = saveInterface(params.html, params.title);
      await pushToUIClaw({
        type: "ui.replace",
        spec: { type: "Canvas", html: params.html, height: params.height ?? 400, title: params.title },
        replace: true,
        title: params.title,
      });
      return {
        content: [{
          type: "text",
          text: "Canvas rendered and saved.\n- ID: " + saved.id + "\n- Size: " + saved.lines + " lines\n- Title: " + (params.title ?? "untitled") + "\n\nUse uiclaw_read(\"" + saved.id + "\") to recall code for modifications.",
        }],
      };
    },
  });

  // ── uiclaw_read ──
  api.registerTool({
    name: "uiclaw_read",
    description: "List saved interfaces (id=\"list\") or read HTML code for editing. Use uiclaw_load to render an existing interface WITHOUT loading code into context. Only use uiclaw_read when you need to MODIFY the code.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Interface ID from a previous uiclaw_canvas result" },
      },
      required: ["id"],
    },
    async execute(_ctx: any, params: { id: string }) {
      if (params.id === "list") {
        var available = listInterfaces();
        var lines = available.map(function(i) { return "- " + i.id + " (" + i.name + ", " + i.sizeKb + "KB)"; });
        var text = lines.length > 0 ? "Available interfaces:\n" + lines.join("\n") : "No interfaces saved yet.";
        return { content: [{ type: "text", text: text }] };
      }
      var html = loadInterface(params.id);
      if (!html) {
        var avail = listInterfaces();
        var ls = avail.map(function(i) { return "- " + i.id + " (" + i.name + ", " + i.sizeKb + "KB)"; });
        return { content: [{ type: "text", text: "Not found: " + params.id + "\n\nAvailable:\n" + (ls.join("\n") || "none") }] };
      }
      return { content: [{ type: "text", text: html }] };
    },
  });

  // ── uiclaw_load ──
  api.registerTool({
    name: "uiclaw_load",
    description: "Load a previously saved interface from the registry and render it directly \u2014 without putting the HTML into context. Use this instead of uiclaw_read when you just want to display an existing interface. Pass the interface ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Interface ID to load and render" },
        height: { type: "number", description: "Height in pixels (default 400)" },
      },
      required: ["id"],
    },
    async execute(_ctx: any, params: { id: string; height?: number }) {
      var html = loadInterface(params.id);
      if (!html) {
        var available = listInterfaces();
        var lines = available.map(function(i) { return "- " + i.id + " (" + i.name + ", " + i.sizeKb + "KB)"; });
        return { content: [{ type: "text", text: "Not found: " + params.id + ". Available: " + (lines.join(", ") || "none") }] };
      }
      // skipRegister: true — don't re-register an already-registered interface
      await pushToUIClaw({
        type: "ui.replace",
        spec: { type: "Canvas", html: html, height: params.height || 400 },
        replace: true,
        skipRegister: true,
      });
      return { content: [{ type: "text", text: "Loaded interface " + params.id + " (" + html.split("\n").length + " lines). Rendered directly from disk." }] };
    },
  });

  // ── uiclaw_form ──
  api.registerTool({
    name: "uiclaw_form",
    description: "Show a form in the UIClaw workspace and wait for user input. Field types: text, textarea, select, number, email, url, checkbox, color, date.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" }, label: { type: "string" }, type: { type: "string" },
              placeholder: { type: "string" }, options: { type: "array", items: { type: "string" } },
              required: { type: "boolean" },
            },
            required: ["id", "label", "type"],
          },
        },
      },
      required: ["title", "fields"],
    },
    async execute(_ctx: any, params: any) {
      var formId = "form_" + Date.now();
      var chatId = typeof _ctx === "string" ? _ctx : (_ctx?.sessionKey ?? "default");
      var session = getSession(chatId);
      await pushToUIClaw({ type: "ui.form", formId: formId, ...params });
      var result = await new Promise<any>(function(resolve) {
        session.pendingForms.set(formId, { resolve: resolve });
        setTimeout(function() {
          if (session.pendingForms.has(formId)) {
            session.pendingForms.delete(formId);
            resolve({ _timeout: true });
          }
        }, 5 * 60000);
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  try {
    api.registerGatewayMethod?.("uiclaw.form.submit", function({ params, respond }: any) {
      var chatId = params.chatId, formId = params.formId, values = params.values;
      var session = uiSessions.get(chatId);
      if (session?.pendingForms.has(formId)) {
        session.pendingForms.get(formId)!.resolve(values);
        session.pendingForms.delete(formId);
        respond(true, { ok: true });
      } else {
        respond(false, { error: "No pending form" });
      }
    });
  } catch {}

  log.info("[UIClaw] Plugin loaded: uiclaw_render, uiclaw_canvas, uiclaw_form, uiclaw_read, uiclaw_load");
}

function countNodes(spec: any): number {
  if (!spec) return 0;
  var n = 1;
  if (spec.children) for (var c of spec.children) n += countNodes(c);
  return n;
}
