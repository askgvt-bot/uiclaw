/**
 * UIClaw UI Engine
 * 
 * Transforms agent text responses into rich UI component specs.
 * Works passively (auto-detects content type) and actively (explicit specs from tools).
 */

export type UIComponent = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export type UISpec = UIComponent & {
  children?: UIComponent[];
};

/**
 * Auto-generate a UI spec from an agent's text response.
 * Analyzes the content and picks appropriate components.
 */
export function autoLayout(text: string, toolResults?: Record<string, unknown>): UISpec | null {
  if (!text || text.length < 50) return null; // Too short for rich UI
  
  const components: UIComponent[] = [];
  let id = 0;
  const nextId = () => `auto_${++id}`;

  // Detect lists/bullet points → Card components
  const listMatch = text.match(/(?:^|\n)((?:\s*[-•*]\s+.+\n?){3,})/gm);
  
  // Detect tables → DataTable
  const tableMatch = text.match(/\|.+\|.+\|\n\|[-\s|]+\|\n(\|.+\|\n?)+/gm);
  
  // Detect code blocks → Canvas
  const codeMatch = text.match(/```[\s\S]+?```/gm);
  
  // Detect numbered items (like "1. Something\n2. Something") → ordered content
  const numberedMatch = text.match(/(?:^|\n)((?:\s*\d+[.)]\s+.+\n?){3,})/gm);
  
  // Detect URLs → link cards
  const urlMatch = text.match(/https?:\/\/[^\s)]+/gm);

  // If there are tool results with structured data, prefer DataTable
  if (toolResults) {
    for (const [toolName, result] of Object.entries(toolResults)) {
      const data = result as any;
      if (data?.results && Array.isArray(data.results)) {
        // Search results → cards with links
        components.push({
          id: nextId(),
          type: "Stack",
          children: data.results.slice(0, 5).map((r: any, i: number) => ({
            id: nextId(),
            type: "Card",
            title: r.title || `Result ${i + 1}`,
            content: r.description || r.snippet || "",
            url: r.url,
          })),
        });
      }
    }
  }

  if (tableMatch) {
    for (const table of tableMatch) {
      const lines = table.trim().split("\n").filter(l => !l.match(/^\|[-\s|]+\|$/));
      const headers = lines[0]?.split("|").filter(Boolean).map(s => s.trim()) ?? [];
      const rows = lines.slice(1).map(line => 
        line.split("|").filter(Boolean).map(s => s.trim())
      );
      components.push({
        id: nextId(),
        type: "DataTable",
        columns: headers,
        rows,
      });
    }
  }

  // Always include the full markdown as base
  components.unshift({
    id: nextId(),
    type: "Markdown",
    content: text,
  });

  if (components.length <= 1) return null; // Just markdown, not worth a layout

  return {
    id: "auto-layout",
    type: "Stack",
    children: components,
  };
}

/**
 * Validate and normalize a UI spec from an agent tool call.
 */
export function normalizeSpec(spec: any): UISpec {
  if (!spec) return { id: "empty", type: "Stack", children: [] };
  
  // Ensure all components have IDs
  let counter = 0;
  function ensureIds(node: any): UIComponent {
    if (!node.id) node.id = `comp_${++counter}`;
    if (node.children) node.children = node.children.map(ensureIds);
    if (node.columns && Array.isArray(node.columns) && node.columns[0]?.type) {
      node.columns = node.columns.map(ensureIds);
    }
    return node;
  }
  
  return ensureIds({ ...spec });
}

/**
 * Merge a new spec into an existing one (for append mode).
 */
export function mergeSpecs(existing: UISpec | null, incoming: UISpec, replace: boolean): UISpec {
  if (replace || !existing) return incoming;
  
  // Append incoming children to existing stack
  if (existing.type === "Stack" && incoming.type === "Stack") {
    return {
      ...existing,
      children: [...(existing.children ?? []), ...(incoming.children ?? [])],
    };
  }
  
  // Wrap both in a stack
  return {
    id: "merged",
    type: "Stack",
    children: [existing, incoming],
  };
}
