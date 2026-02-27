# ✨ UIClaw

**Rich dynamic web UI for OpenClaw agents.**

UIClaw gives your OpenClaw agent a modern split-panel web interface — chat on the left, dynamic workspace on the right. The agent can push interactive forms, data tables, image grids, custom HTML canvases, and more to the workspace while keeping the conversation clean.

![UIClaw Screenshot](https://ui.gvtbot.net/screenshot.png)

## Features

- 💬 **Chat + Workspace** — Split-panel: conversation on the left, rich UI on the right
- 🎨 **Dynamic UI Generation** — Agent pushes component trees (Cards, Tables, Markdown, Canvas, ImageGrid, Forms)
- 📝 **Smart Forms** — Collect structured input via `uiclaw_form` or custom Canvas HTML
- 🖼️ **Image Serving** — Local file paths auto-transformed to servable URLs
- 🔄 **Canvas Bridge** — Custom HTML can send structured data back to the agent via `sendToApp()` — no chat pollution
- ⏳ **Loading States** — "Building UI..." overlay while the agent works
- 🔌 **OpenClaw Plugin** — Registers `uiclaw_render`, `uiclaw_canvas`, `uiclaw_form` as agent tools
- 🌐 **Works Anywhere** — Localhost or behind Cloudflare Tunnel

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (React)                                     │
│  ┌──────────┐  ┌──────────────────────────────────┐ │
│  │   Chat    │  │         Workspace Panel          │ │
│  │  panel    │  │  Cards / Tables / Canvas / Forms │ │
│  └────┬─────┘  └──────────────┬───────────────────┘ │
│       │ WebSocket              │ postMessage          │
└───────┼────────────────────────┼─────────────────────┘
        ↕                        ↕
┌───────────────────────────────────────────────────────┐
│  UIClaw Server (Node.js, port 3800)                   │
│  • Bridges browser ↔ OpenClaw Gateway via WebSocket   │
│  • POST /api/ui — receives UI specs from plugin       │
│  • GET /files/* — serves local images/files           │
│  • Transforms local paths → servable URLs             │
└───────────────────┬───────────────────────────────────┘
                    ↕ Gateway WebSocket (JSON-RPC)
┌───────────────────────────────────────────────────────┐
│  OpenClaw Gateway                                     │
│  • Runs the agent session (agent:main:uiclaw)         │
│  • Plugin tools: uiclaw_render, uiclaw_canvas,        │
│    uiclaw_form push specs via HTTP to UIClaw server    │
└───────────────────────────────────────────────────────┘
```

### Data Flow

**User → Agent:**
1. User types in chat or submits a Canvas form
2. Chat messages go: Browser → WS → UIClaw Server → Gateway → Agent
3. Canvas actions go: iframe `sendToApp()` → postMessage → WS → Server → Gateway → Agent as `[CANVAS_ACTION]` block

**Agent → User:**
1. Agent calls `uiclaw_render` / `uiclaw_canvas` / `uiclaw_form`
2. Plugin POSTs spec to `http://localhost:3800/api/ui`
3. Server transforms file paths, pushes to all browser clients via WS
4. React renders the component in the workspace panel

## Quick Start

### 1. Install dependencies

```bash
git clone https://github.com/askgvt-bot/uiclaw.git
cd uiclaw
pnpm install
```

### 2. Build the frontend

```bash
cd packages/web && pnpm build && cd ../..
```

### 3. Configure OpenClaw

Add the plugin to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "allow": ["uiclaw"],
    "paths": ["/path/to/uiclaw/extensions/uiclaw/index.ts"]
  }
}
```

Or let OpenClaw auto-discover it (it will warn about unsigned plugins).

### 4. Start the server

```bash
cd packages/server
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789 \
OPENCLAW_GATEWAY_TOKEN=your-gateway-token \
npx tsx src/index.ts
```

### 5. Open the UI

Navigate to `http://localhost:3800` — or set up a Cloudflare Tunnel for remote access.

## Agent Tools

### `uiclaw_render`

Push a component tree to the workspace panel.

```json
{
  "spec": {
    "type": "Stack",
    "children": [
      { "type": "Card", "title": "Revenue", "icon": "💰", "content": "$2.3M" },
      { "type": "DataTable", "columns": ["Q", "Rev"], "rows": [["Q1", "$500K"]] }
    ]
  }
}
```

**Component types:** `Stack`, `Markdown`, `Card`, `DataTable`, `Canvas`, `ImageGrid`, `ColorPalette`, `Columns`

### `uiclaw_canvas`

Push custom HTML/CSS/JS rendered in a sandboxed iframe.

```json
{
  "html": "<h1>Hello</h1><button onclick=\"sendToApp('action', {clicked: true})\">Click me</button>",
  "height": 400,
  "title": "My Widget"
}
```

The `sendToApp(type, data)` function is automatically injected — use it to send structured data back to the agent without polluting the chat.

### `uiclaw_form`

Show a form and collect user input.

```json
{
  "title": "Preferences",
  "fields": [
    { "id": "name", "label": "Name", "type": "text", "required": true },
    { "id": "style", "label": "Style", "type": "select", "options": ["Minimal", "Bold"] }
  ]
}
```

## Canvas Bridge

Custom Canvas HTML can communicate back to the agent:

```html
<button onclick="sendToApp('research', { names: ['Nick Halstead'] })">
  Research
</button>
```

This sends a `[CANVAS_ACTION]` message to the agent, which can then process the data and push results back to the workspace. The data never appears in the chat.

## File Serving

When the agent references local files (e.g., generated images), the server automatically:

1. Transforms `/Users/.../image.png` → `/files/Users/.../image.png`
2. Serves the file via `GET /files/*` with proper MIME types
3. Restricts access to allowed directories (workspace, media, projects)

## Project Structure

```
uiclaw/
├── extensions/uiclaw/     # OpenClaw plugin (agent tools)
│   └── index.ts
├── packages/
│   ├── server/            # Node.js bridge server
│   │   └── src/
│   │       ├── index.ts          # HTTP + WS server
│   │       └── gateway-client.ts # OpenClaw Gateway client
│   ├── web/               # React frontend
│   │   └── src/
│   │       ├── App.tsx           # Main app + hooks
│   │       └── components.tsx    # UI component renderers
│   └── ui-engine/         # Layout + component utilities
├── Dockerfile             # Container build (optional)
└── README.md
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WebSocket URL |
| `OPENCLAW_GATEWAY_TOKEN` | — | Gateway auth token |
| `UICLAW_PORT` | `3800` | Server port |
| `UICLAW_HOST` | `127.0.0.1` | Server bind address |
| `UICLAW_URL` | `http://127.0.0.1:3800` | Plugin push URL (in extension) |

## Running as a Service (macOS)

```bash
# Copy the launchd plist
cp com.gvtbot.uiclaw.plist ~/Library/LaunchAgents/

# Load and start
launchctl load ~/Library/LaunchAgents/com.gvtbot.uiclaw.plist
```

## Development

```bash
# Dev mode (auto-reload)
cd packages/server && pnpm dev

# Build frontend
cd packages/web && pnpm build

# Rebuild after changes
pnpm build && pkill -f "tsx src/index.ts" && pnpm start
```

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) running locally
- Node.js 22+
- pnpm

## License

MIT
