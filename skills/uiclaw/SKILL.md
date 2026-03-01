# UIClaw Skill

UIClaw provides a rich web UI for OpenClaw agents at **https://ui.gvtbot.net**

## How It Works

When users chat through UIClaw, your responses automatically render as rich UI:
- **Tables** → interactive DataTable component
- **Code blocks** → styled code with language labels  
- **Images** → ImageGrid gallery
- **Color hex codes** → ColorPalette swatches
- **Markdown** → formatted text with headers, bold, lists, links

## Explicit UI Specs

For full control, embed `:::uiclaw` blocks in your response:

```
:::uiclaw
{
  "type": "Stack",
  "children": [
    { "type": "Card", "title": "Revenue", "icon": "💰", "content": "$2.3M ARR" },
    { "type": "DataTable", "columns": ["Q", "Revenue"], "rows": [["Q1", "$500K"], ["Q2", "$680K"]] }
  ]
}
:::
```

## Available Components

| Type | Props | Use For |
|------|-------|---------|
| `Stack` | `direction` (vertical/horizontal), `children` | Layout container |
| `Markdown` | `content` | Formatted text |
| `Card` | `title`, `content`, `icon`, `url` | Info cards |
| `DataTable` | `columns`, `rows` | Tabular data |
| `Canvas` | `html`, `height`, `title` | Custom HTML/SVG |
| `ImageGrid` | `images` [{src, alt}], `columns` | Image galleries |
| `ColorPalette` | `colors` [{hex, label}] | Color swatches |

## Session

UIClaw uses session key `"uiclaw"` — separate from WhatsApp/Telegram sessions.

## Architecture

Browser → UIClaw Server (Docker, port 3800) → OpenClaw Gateway WebSocket (protocol v3)

## Interface Registry & Reuse

UIClaw saves every interface to disk at `~/.openclaw/workspace/uiclaw-registry/interfaces/`. Use tools to work with them:

### Workflow

1. **First:** Call `uiclaw_read(id="list")` to see what's already built
2. **If a match exists:** Call `uiclaw_load(id)` to render it instantly (zero context cost, near-instant)
3. **If no match:** Build with `uiclaw_canvas` as normal (it auto-saves for next time)
4. **To modify an existing interface:** Call `uiclaw_read(id)` to get the code, edit it, then `uiclaw_canvas` the updated version

### Important: Be Silent About It

- **Never tell the user** you're checking the registry — just do it
- **Never say** "I didn't find a match" or "Let me check what's available"
- From the user's perspective, you either instantly load something or build it — the registry is invisible plumbing

### Auto-Registration

All rendered interfaces are automatically saved to the registry. No manual registration needed.
