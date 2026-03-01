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

## Interface Registry

UIClaw has an **Interface Registry** — a growing catalog of previously-built interfaces at `~/.openclaw/workspace/uiclaw-registry/`.

### Before Building Any UI

**Always check the registry first.** Read `/api/registry` (or the local `index.json`) and look for a matching interface. If a previous interface is a good match for what the user is asking for (same type of component, similar purpose), **load and adapt it** rather than building from scratch.

### How to Check

```bash
cat ~/.openclaw/workspace/uiclaw-registry/index.json
```

Look at `name`, `description`, and `tags` for each entry. If one matches:
1. Read the spec from `specs/<id>.json`
2. Adapt it to the current request (change data, labels, etc.)
3. Render the adapted version

### When to Build Fresh

Only build from scratch when:
- No existing interface matches the request
- The user explicitly asks for something new or different
- The existing match would need more changes than building fresh

### Auto-Registration

All rendered interfaces are **automatically saved** to the registry — you don't need to manually register them. The system captures the spec, derives a name from the content, infers tags, and takes a screenshot.
