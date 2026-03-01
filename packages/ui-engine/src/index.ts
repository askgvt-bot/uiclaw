/**
 * UIClaw UI Engine
 * 
 * Transforms agent text responses into rich UI component specs.
 * Two modes:
 * 1. Explicit: agent embeds :::uiclaw JSON blocks
 * 2. Auto: detects tables, code, lists, URLs, images → rich components
 */

export type UIComponent = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export type UISpec = UIComponent & {
  children?: UIComponent[];
};

let _counter = 0;
const nextId = () => `c_${++_counter}`;

/**
 * Extract explicit :::uiclaw JSON blocks from text.
 * Format: :::uiclaw\n{...JSON spec...}\n:::
 */
function extractExplicitSpecs(text: string): { specs: UISpec[]; cleanText: string } {
  const specs: UISpec[] = [];
  const cleanText = text.replace(/:::uiclaw\n([\s\S]*?)\n:::/g, (_, json) => {
    try {
      const spec = JSON.parse(json.trim());
      specs.push(normalizeSpec(spec));
    } catch (e) {
      // Invalid JSON, leave as text
      return _;
    }
    return "";
  }).trim();
  return { specs, cleanText };
}

/**
 * Detect markdown tables → DataTable components
 */
function detectTables(text: string): UIComponent[] {
  const components: UIComponent[] = [];
  const tableRegex = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/gm;
  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(text)) !== null) {
    const headerLine = match[1];
    const bodyLines = match[2].trim().split("\n");
    const headers = headerLine.split("|").map(s => s.trim()).filter(Boolean);
    const rows = bodyLines.map(line =>
      line.split("|").map(s => s.trim()).filter(Boolean)
    );
    components.push({
      id: nextId(),
      type: "DataTable",
      columns: headers,
      rows,
    });
  }
  return components;
}

/**
 * Detect code blocks → Canvas components with syntax highlighting
 */
function detectCodeBlocks(text: string): UIComponent[] {
  const components: UIComponent[] = [];
  const codeRegex = /```(\w*)\n([\s\S]*?)```/gm;
  let match: RegExpExecArray | null;
  while ((match = codeRegex.exec(text)) !== null) {
    const lang = match[1] || "text";
    const code = match[2].trim();
    
    // HTML/SVG code → render as Canvas
    if (lang === "html" || lang === "svg" || code.includes("<svg") || code.includes("<!DOCTYPE")) {
      components.push({
        id: nextId(),
        type: "Canvas",
        html: code,
        height: 400,
        title: lang === "svg" ? "SVG Preview" : "HTML Preview",
      });
    } else {
      // Code block → styled code display
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      components.push({
        id: nextId(),
        type: "Canvas",
        html: `<pre style="background:#1e293b;color:#e2e8f0;padding:16px;border-radius:8px;overflow-x:auto;font-family:'Fira Code',monospace;font-size:13px;line-height:1.5;margin:0"><code>${escaped}</code></pre>`,
        height: Math.min(60 + code.split("\n").length * 22, 500),
        title: lang !== "text" ? lang : undefined,
      });
    }
  }
  return components;
}

/**
 * Detect image URLs → ImageGrid
 */
function detectImages(text: string): UIComponent[] {
  const imgRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg)[^\s)]*)\)/gm;
  const images: { alt: string; url: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(text)) !== null) {
    images.push({ alt: match[1], url: match[2] });
  }
  
  // Also check for raw image URLs
  const rawImgRegex = /(?:^|\s)(https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s)]*)?)/gm;
  while ((match = rawImgRegex.exec(text)) !== null) {
    if (!images.some(i => i.url === match![1])) {
      images.push({ alt: "", url: match[1] });
    }
  }
  
  if (images.length === 0) return [];
  return [{
    id: nextId(),
    type: "ImageGrid",
    images: images.map(i => ({ src: i.url, alt: i.alt })),
    columns: images.length <= 2 ? images.length : 3,
  }];
}

/**
 * Detect bullet lists with structure → Card grid
 */
function detectStructuredList(text: string): UIComponent[] {
  // Look for patterns like "### Title\n- Point 1\n- Point 2" repeated
  const sectionRegex = /(?:^|\n)###?\s+(.+)\n((?:\s*[-•*]\s+.+\n?)+)/gm;
  const sections: { title: string; items: string[] }[] = [];
  let match: RegExpExecArray | null;
  while ((match = sectionRegex.exec(text)) !== null) {
    const title = match[1].trim();
    const items = match[2].trim().split("\n").map(l => l.replace(/^\s*[-•*]\s+/, "").trim()).filter(Boolean);
    sections.push({ title, items });
  }
  
  if (sections.length < 2) return [];
  return [{
    id: nextId(),
    type: "Stack",
    direction: "horizontal",
    children: sections.map(s => ({
      id: nextId(),
      type: "Card",
      title: s.title,
      content: s.items.map(i => `• ${i}`).join("\n"),
    })),
  }];
}

/**
 * Detect color values → ColorPalette
 */
function detectColors(text: string): UIComponent[] {
  const hexRegex = /#(?:[0-9a-fA-F]{3}){1,2}\b/g;
  const colors = [...new Set(text.match(hexRegex) ?? [])];
  if (colors.length < 3) return [];
  return [{
    id: nextId(),
    type: "ColorPalette",
    colors: colors.map(c => ({ hex: c, label: c })),
  }];
}

/**
 * Detect URLs → LinkCards
 */
function detectLinks(text: string): UIComponent[] {
  // Named links: [text](url)
  const namedRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gm;
  const links: { title: string; url: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = namedRegex.exec(text)) !== null) {
    links.push({ title: match[1], url: match[2] });
  }
  
  if (links.length < 2) return [];
  return [{
    id: nextId(),
    type: "Stack",
    direction: "horizontal",
    children: links.slice(0, 6).map(l => ({
      id: nextId(),
      type: "Card",
      title: l.title,
      url: l.url,
      content: new URL(l.url).hostname,
    })),
  }];
}

/**
 * Auto-generate a UI spec from an agent's text response.
 */
export function autoLayout(text: string): UISpec | null {
  if (!text || text.length < 30) return null;
  
  // 1. Check for explicit :::uiclaw blocks
  const { specs, cleanText } = extractExplicitSpecs(text);
  if (specs.length > 0) {
    return specs.length === 1 ? specs[0] : {
      id: "explicit-layout",
      type: "Stack",
      children: specs,
    };
  }

  // 2. Auto-detect rich content
  // Markdown component handles code blocks, bold, lists etc natively.
  // Only add extra components for tables, images, colors, links.
  const extras: UIComponent[] = [];
  
  const tables = detectTables(text);
  const images = detectImages(text);
  const colors = detectColors(text);
  
  extras.push(...tables, ...images, ...colors);
  
  // For any response > 100 chars, render as rich Markdown (+ extras)
  if (text.length > 100 || extras.length > 0) {
    const children: UIComponent[] = [
      { id: nextId(), type: "Markdown", content: cleanText || text },
      ...extras,
    ];
    return {
      id: "auto-layout",
      type: "Stack",
      children,
    };
  }
  
  return null;
}

/**
 * Validate and normalize a UI spec.
 */
export function normalizeSpec(spec: any): UISpec {
  if (!spec) return { id: "empty", type: "Stack", children: [] };
  
  function ensureIds(node: any): UIComponent {
    if (!node.id) node.id = nextId();
    if (node.children) node.children = node.children.map(ensureIds);
    return node;
  }
  
  return ensureIds({ ...spec });
}

/**
 * Merge specs (append or replace).
 */
export function mergeSpecs(existing: UISpec | null, incoming: UISpec, replace: boolean): UISpec {
  if (replace || !existing) return incoming;
  
  if (existing.type === "Stack" && incoming.type === "Stack") {
    return {
      ...existing,
      children: [...(existing.children ?? []), ...(incoming.children ?? [])],
    };
  }
  
  return {
    id: "merged",
    type: "Stack",
    children: [existing, incoming],
  };
}
