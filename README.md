# ✨ UIClaw

**Rich dynamic web interfaces for OpenClaw agents.**

UIClaw is an open-source OpenClaw plugin that gives your AI agent a modern web UI with dynamic layouts, form collection, data visualization, and interactive workspaces — all powered by your existing OpenClaw setup.

## What it does

- 🎨 **Dynamic UI Generation** — Agent responses automatically get rich layouts (cards, tables, charts, canvases)
- 📝 **Smart Forms** — Collect structured input from users with auto-generated forms
- 💬 **Chat + Workspace** — Split-panel interface: conversation on the left, dynamic workspace on the right
- 🔌 **Plugin Architecture** — Registers as an OpenClaw channel + provides UI tools to your agent
- 🌐 **Works Everywhere** — Access from any browser, localhost or remote

## How it works

```
Browser (React)
    ↕ WebSocket
UIClaw Server
    ↕ OpenClaw Gateway WebSocket (chat.send / chat.history)
OpenClaw Agent
    ↕ UIClaw skill tools (render_layout, collect_form, show_canvas)
```

OpenClaw handles all the thinking — LLM calls, tool execution, memory, sessions.
UIClaw handles the **presentation layer** — turning agent responses into rich, interactive web interfaces.

## Quick Start

```bash
# Install
npm install -g uiclaw

# Start (connects to local OpenClaw gateway)
uiclaw start

# Opens browser at http://localhost:3800
```

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) running locally
- Node.js 20+

## Architecture

UIClaw is three things:

1. **OpenClaw Plugin** (`extensions/uiclaw/`) — Registers a `uiclaw` channel + agent tools
2. **UI Engine** (`packages/ui-engine/`) — Transforms agent responses into UI specs
3. **Web Frontend** (`packages/web/`) — React app with chat + dynamic workspace

### Plugin provides:

- **Channel**: Messages from the web UI flow through OpenClaw like WhatsApp/Telegram
- **Agent Tools**: `render_layout`, `collect_form`, `show_canvas`, `show_data_table`
- **Skill**: SKILL.md teaches the agent how to use UI tools effectively

### UI Engine provides:

- **Auto-layout**: Analyzes text responses and generates appropriate UI components
- **Component library**: Markdown, Canvas, Cards, Tables, Charts, Forms, ImageGrid, ColorPalette
- **Dark mode**: Consistent dark theme across all components

## Development

```bash
git clone https://github.com/nicholashalstead/uiclaw
cd uiclaw
pnpm install
pnpm dev
```

## License

MIT
