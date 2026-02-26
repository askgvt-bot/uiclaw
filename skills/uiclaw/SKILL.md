---
name: uiclaw
description: "Render rich dynamic web interfaces for users via the UIClaw web UI. Use when the user is connected through the UIClaw channel and you want to display structured layouts, forms, data tables, charts, or interactive content."
metadata:
  openclaw:
    emoji: "✨"
---

# UIClaw — Dynamic Web Interfaces

When a user is connected via the UIClaw web channel, you have access to tools that render rich UI in their browser alongside the chat conversation.

## Available Tools

### `uiclaw_render` — Push a layout to the workspace

Use this to display structured content. The spec is a component tree:

```json
{
  "type": "Stack",
  "children": [
    { "type": "Markdown", "content": "# Research Results\nHere's what I found:" },
    {
      "type": "DataTable",
      "columns": ["Company", "Revenue", "Employees"],
      "rows": [
        ["Apple", "$394B", "164,000"],
        ["Google", "$307B", "182,000"]
      ]
    },
    {
      "type": "Card",
      "title": "Key Insight",
      "content": "Apple leads in revenue per employee."
    }
  ]
}
```

**Component types:**
- `Stack` — Container with `children` (vertical by default, set `direction: "horizontal"`)
- `Markdown` — Rendered markdown (`content` field)
- `Card` — Titled card (`title`, `content`, optional `icon`)
- `DataTable` — Table with `columns` (string[]) and `rows` (string[][])
- `Canvas` — Custom HTML (`html` field, optional `height`)
- `ImageGrid` — Array of `images` with `url` and `caption`
- `ColorPalette` — Array of `colors` with `hex` and `name`
- `Columns` — Side-by-side layout with `columns` array of child components
- `LogView` — Array of `logs` (string[])

### `uiclaw_form` — Collect structured input

Use this when you need specific information from the user before proceeding:

```json
{
  "title": "Project Setup",
  "description": "Tell me about your project so I can help.",
  "fields": [
    { "id": "name", "label": "Project Name", "type": "text", "required": true },
    { "id": "type", "label": "Project Type", "type": "select", "options": ["Web App", "Mobile", "API", "CLI"] },
    { "id": "description", "label": "Brief Description", "type": "textarea", "placeholder": "What does it do?" },
    { "id": "hasDesign", "label": "Do you have existing designs?", "type": "checkbox" }
  ]
}
```

**Field types:** text, textarea, select, number, email, url, checkbox, radio, color, date

The tool blocks until the user submits the form, then returns their answers as JSON.

### `uiclaw_canvas` — Render custom HTML

For charts, visualizations, or anything custom:

```json
{
  "html": "<div style='padding:20px'><h2>Chart</h2><canvas id='myChart'></canvas></div>",
  "height": 300,
  "title": "Sales Data"
}
```

## When to use these tools

- **Always use `uiclaw_form`** before creative tasks (logos, designs, content) to collect requirements
- **Use `uiclaw_render`** when displaying structured data, comparisons, or multi-section results
- **Use `uiclaw_canvas`** for custom visualizations, charts, or interactive content
- **Don't use these tools** for simple text responses — just reply normally in chat

## Tips

- Build layouts progressively — start with key info, add details
- Use `Stack` with `direction: "horizontal"` for side-by-side comparisons
- DataTable is great for structured data (pricing, specs, comparisons)
- Markdown component supports full markdown including code blocks
- Canvas HTML gets dark-mode CSS injected automatically
