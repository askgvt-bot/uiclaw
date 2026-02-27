/**
 * UIClaw — OpenClaw Plugin
 * 
 * Registers agent tools for rendering rich UI in the UIClaw web client.
 * Tools push UI specs to the UIClaw server via HTTP POST.
 */

const UICLAW_URL = process.env.UICLAW_URL ?? "http://127.0.0.1:3800";

async function pushToUIClaw(data: Record<string, unknown>): Promise<void> {
  console.log(`[UIClaw Plugin] pushToUIClaw called, url=${UICLAW_URL}/api/ui, keys=${Object.keys(data).join(",")}`);
  console.log(`[UIClaw Plugin] spec: ${JSON.stringify(data).slice(0, 2000)}`);
  try {
    const res = await fetch(`${UICLAW_URL}/api/ui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    console.log(`[UIClaw Plugin] Push result: ${res.status} ${body}`);
  } catch (e: any) {
    console.error(`[UIClaw Plugin] Push error: ${e.message}`);
  }
}

// In-memory UI state per chat
const uiSessions = new Map<string, { currentUi: any; pendingForms: Map<string, { resolve: (v: any) => void }> }>();

function getSession(id: string) {
  if (!uiSessions.has(id)) uiSessions.set(id, { currentUi: null, pendingForms: new Map() });
  return uiSessions.get(id)!;
}

export default function register(api: any) {
  const log = api.logger ?? console;

  // ── Tool: uiclaw_render ─────────────────────────────────
  api.registerTool({
    name: "uiclaw_render",
    description: `Push a rich UI layout to the UIClaw web workspace panel. Use when you want to display structured visual content separate from chat text.

Component types: Stack (container), Markdown (formatted text), Card (titled info card), DataTable (rows/columns), Canvas (custom HTML/SVG/JS), ImageGrid (image gallery), ColorPalette (color swatches).

Example: { "type": "Stack", "children": [{ "type": "Card", "title": "Revenue", "icon": "💰", "content": "$2.3M" }, { "type": "DataTable", "columns": ["Q","Rev"], "rows": [["Q1","$500K"]] }] }`,
    parameters: {
      type: "object",
      properties: {
        spec: { type: "object", description: "UI component tree" },
        replace: { type: "boolean", description: "Replace current UI (default true)" },
      },
      required: ["spec"],
    },
    async execute(_ctx: any, params: { spec: any; replace?: boolean }) {
      const chatId = typeof _ctx === "string" ? _ctx : _ctx?.sessionKey ?? "default";
      const session = getSession(chatId);
      session.currentUi = params.spec;

      // Push UI spec to UIClaw server via HTTP
      await pushToUIClaw({
        type: "ui.replace",
        spec: params.spec,
        replace: params.replace ?? true,
      });

      return { content: [{ type: "text", text: `UI rendered (${countNodes(params.spec)} components)` }] };
    },
  });

  // ── Tool: uiclaw_canvas ─────────────────────────────────
  api.registerTool({
    name: "uiclaw_canvas",
    description: "Render custom HTML/CSS/JS in the UIClaw web workspace. Use for charts, visualizations, interactive widgets, or any custom rendering.",
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
      await pushToUIClaw({
        type: "ui.replace",
        spec: { type: "Canvas", html: params.html, height: params.height ?? 400, title: params.title },
        replace: false,
      });
      return { content: [{ type: "text", text: "Canvas rendered." }] };
    },
  });

  // ── Tool: uiclaw_form ───────────────────────────────────
  api.registerTool({
    name: "uiclaw_form",
    description: `Show a form in the UIClaw web workspace and wait for user input. Field types: text, textarea, select, number, email, url, checkbox, color, date.

Example: { "title": "Preferences", "fields": [{ "id": "style", "label": "Style", "type": "select", "options": ["Minimal","Bold"] }, { "id": "color", "label": "Color", "type": "color" }] }`,
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
              id: { type: "string" },
              label: { type: "string" },
              type: { type: "string" },
              placeholder: { type: "string" },
              options: { type: "array", items: { type: "string" } },
              required: { type: "boolean" },
            },
            required: ["id", "label", "type"],
          },
        },
      },
      required: ["title", "fields"],
    },
    async execute(_ctx: any, params: any) {
      const formId = `form_${Date.now()}`;
      const chatId = typeof _ctx === "string" ? _ctx : _ctx?.sessionKey ?? "default";
      const session = getSession(chatId);

      await pushToUIClaw({ type: "ui.form", formId, ...params });

      const result = await new Promise<any>((resolve) => {
        session.pendingForms.set(formId, { resolve });
        setTimeout(() => {
          if (session.pendingForms.has(formId)) {
            session.pendingForms.delete(formId);
            resolve({ _timeout: true });
          }
        }, 5 * 60_000);
      });

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });

  // ── RPC: form submit ────────────────────────────────────
  try {
    api.registerGatewayMethod?.("uiclaw.form.submit", ({ params, respond }: any) => {
      const { chatId, formId, values } = params;
      const session = uiSessions.get(chatId);
      if (session?.pendingForms.has(formId)) {
        session.pendingForms.get(formId)!.resolve(values);
        session.pendingForms.delete(formId);
        respond(true, { ok: true });
      } else {
        respond(false, { error: "No pending form" });
      }
    });
  } catch { /* RPC registration optional */ }

  log.info("[UIClaw] Plugin loaded: uiclaw_render, uiclaw_canvas, uiclaw_form tools registered");
}

function countNodes(spec: any): number {
  if (!spec) return 0;
  let n = 1;
  if (spec.children) for (const c of spec.children) n += countNodes(c);
  return n;
}
