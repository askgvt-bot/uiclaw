/**
 * UIClaw — OpenClaw Plugin
 * 
 * Registers:
 * 1. A "uiclaw" messaging channel (web UI ↔ OpenClaw gateway)
 * 2. Agent tools for rendering rich UI (render_layout, collect_form, etc.)
 * 3. A background service that serves the web frontend
 * 4. Gateway RPC methods for UI spec exchange
 */

import { Type } from "@sinclair/typebox";

// In-memory store for active UI sessions
const uiSessions = new Map<string, {
  currentUi: any;
  pendingForms: Map<string, { resolve: (value: any) => void; spec: any }>;
}>();

function getOrCreateUiSession(chatId: string) {
  if (!uiSessions.has(chatId)) {
    uiSessions.set(chatId, { currentUi: null, pendingForms: new Map() });
  }
  return uiSessions.get(chatId)!;
}

export default function register(api: any) {
  const logger = api.logger ?? console;

  // ──────────────────────────────────────────────
  // 1. Register the UIClaw channel
  // ──────────────────────────────────────────────
  const channelPlugin = {
    id: "uiclaw",
    meta: {
      id: "uiclaw",
      label: "UIClaw",
      selectionLabel: "UIClaw (Web UI)",
      docsPath: "/channels/uiclaw",
      blurb: "Rich dynamic web interfaces for OpenClaw agents.",
      aliases: ["ui", "webui"],
    },
    capabilities: {
      chatTypes: ["direct"] as const,
    },
    config: {
      listAccountIds: (cfg: any) =>
        Object.keys(cfg.channels?.uiclaw?.accounts ?? { default: true }),
      resolveAccount: (cfg: any, accountId: string) =>
        cfg.channels?.uiclaw?.accounts?.[accountId ?? "default"] ?? { accountId },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ text, chatId }: { text: string; chatId: string }) => {
        // Agent response → broadcast to connected web clients via RPC
        const uiSession = getOrCreateUiSession(chatId);
        
        // Store raw text for the UI engine to transform
        api.gateway?.broadcast?.("uiclaw.agent.message", {
          chatId,
          text,
          ui: uiSession.currentUi,
          timestamp: new Date().toISOString(),
        });
        
        return { ok: true };
      },
    },
  };

  api.registerChannel({ plugin: channelPlugin });

  // ──────────────────────────────────────────────
  // 2. Register agent tools
  // ──────────────────────────────────────────────

  // Tool: render_layout — Push a structured UI layout to the web client
  api.registerTool({
    name: "uiclaw_render",
    description: `Render a rich UI layout in the user's web browser. Use this to display structured content like cards, tables, charts, forms, or custom HTML. The layout spec uses a component tree format.

Available component types:
- Stack: vertical/horizontal container with children
- Markdown: rendered markdown text
- Card: titled card with content
- DataTable: rows and columns
- Canvas: custom HTML/CSS
- ImageGrid: grid of images or link cards
- Form: input form with fields
- Chart: data visualization
- ColorPalette: color swatches

Example spec:
{
  "type": "Stack",
  "children": [
    { "type": "Markdown", "content": "# Results\\nHere are the findings:" },
    { "type": "DataTable", "columns": ["Name", "Value"], "rows": [["GDP", "$3.5T"], ["Pop", "67M"]] }
  ]
}`,
    parameters: Type.Object({
      spec: Type.Any({ description: "UI component tree specification" }),
      replace: Type.Optional(Type.Boolean({ description: "Replace current UI (true) or append (false). Default: true" })),
    }),
    async execute(_id: string, params: { spec: any; replace?: boolean }) {
      // Store the UI spec and broadcast to connected clients
      const chatId = _id; // The session/chat context
      const uiSession = getOrCreateUiSession(chatId);
      uiSession.currentUi = params.spec;
      
      api.gateway?.broadcast?.("uiclaw.ui.update", {
        chatId,
        spec: params.spec,
        replace: params.replace ?? true,
      });

      return {
        content: [{ type: "text", text: `UI layout rendered successfully with ${countComponents(params.spec)} components.` }],
      };
    },
  }, { optional: true });

  // Tool: collect_form — Show a form and collect structured input
  api.registerTool({
    name: "uiclaw_form",
    description: `Display a form in the user's web browser and wait for their input. Use this when you need structured data from the user (preferences, parameters, choices).

Field types: text, textarea, select, number, email, url, checkbox, radio, color, date

Example:
{
  "title": "Logo Preferences",
  "fields": [
    { "id": "style", "label": "Style", "type": "select", "options": ["Minimal", "Bold", "Playful"] },
    { "id": "colors", "label": "Color preferences", "type": "text", "placeholder": "e.g., blue and white" },
    { "id": "includeText", "label": "Include company name?", "type": "checkbox" }
  ]
}`,
    parameters: Type.Object({
      title: Type.String({ description: "Form title" }),
      description: Type.Optional(Type.String({ description: "Form description/instructions" })),
      fields: Type.Array(Type.Object({
        id: Type.String(),
        label: Type.String(),
        type: Type.String(),
        placeholder: Type.Optional(Type.String()),
        options: Type.Optional(Type.Array(Type.String())),
        required: Type.Optional(Type.Boolean()),
        default: Type.Optional(Type.Any()),
      })),
    }),
    async execute(_id: string, params: { title: string; description?: string; fields: any[] }) {
      const chatId = _id;
      const formId = `form_${Date.now()}`;
      const uiSession = getOrCreateUiSession(chatId);
      
      // Broadcast form to web client
      api.gateway?.broadcast?.("uiclaw.form.show", {
        chatId,
        formId,
        title: params.title,
        description: params.description,
        fields: params.fields,
      });

      // Wait for form submission (with timeout)
      const result = await new Promise<any>((resolve) => {
        uiSession.pendingForms.set(formId, { resolve, spec: params });
        // Timeout after 5 minutes
        setTimeout(() => {
          if (uiSession.pendingForms.has(formId)) {
            uiSession.pendingForms.delete(formId);
            resolve({ _timeout: true, _message: "Form timed out after 5 minutes" });
          }
        }, 5 * 60 * 1000);
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  }, { optional: true });

  // Tool: show_canvas — Render custom HTML
  api.registerTool({
    name: "uiclaw_canvas",
    description: "Render custom HTML/CSS/JS in the user's web browser. Use for charts, visualizations, or any custom rendering.",
    parameters: Type.Object({
      html: Type.String({ description: "HTML content to render" }),
      height: Type.Optional(Type.Number({ description: "Height in pixels (default: 400)" })),
      title: Type.Optional(Type.String({ description: "Canvas title" })),
    }),
    async execute(_id: string, params: { html: string; height?: number; title?: string }) {
      api.gateway?.broadcast?.("uiclaw.ui.update", {
        chatId: _id,
        spec: {
          type: "Canvas",
          html: params.html,
          height: params.height ?? 400,
          title: params.title,
        },
        replace: false,
      });
      return { content: [{ type: "text", text: "Canvas rendered." }] };
    },
  }, { optional: true });

  // ──────────────────────────────────────────────
  // 3. Gateway RPC methods
  // ──────────────────────────────────────────────

  // Web client submits a form
  api.registerGatewayMethod("uiclaw.form.submit", ({ params, respond }: any) => {
    const { chatId, formId, values } = params;
    const uiSession = uiSessions.get(chatId);
    if (uiSession?.pendingForms.has(formId)) {
      const pending = uiSession.pendingForms.get(formId)!;
      pending.resolve(values);
      uiSession.pendingForms.delete(formId);
      respond(true, { ok: true });
    } else {
      respond(false, { error: "No pending form found" });
    }
  });

  // Web client requests current UI state
  api.registerGatewayMethod("uiclaw.ui.get", ({ params, respond }: any) => {
    const { chatId } = params;
    const uiSession = uiSessions.get(chatId);
    respond(true, { ui: uiSession?.currentUi ?? null });
  });

  // ──────────────────────────────────────────────
  // 4. CLI command
  // ──────────────────────────────────────────────
  api.registerCli(
    ({ program }: any) => {
      program
        .command("uiclaw")
        .description("UIClaw web UI management")
        .action(() => {
          console.log("UIClaw is running as part of the OpenClaw gateway.");
          console.log("Open your browser to http://localhost:3800");
        });
    },
    { commands: ["uiclaw"] }
  );

  logger.info("[UIClaw] Plugin registered: channel + tools + RPC");
}

function countComponents(spec: any): number {
  if (!spec) return 0;
  let count = 1;
  if (spec.children) count += spec.children.reduce((n: number, c: any) => n + countComponents(c), 0);
  if (spec.columns) count += spec.columns.reduce((n: number, c: any) => n + countComponents(c), 0);
  return count;
}
