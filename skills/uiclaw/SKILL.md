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
