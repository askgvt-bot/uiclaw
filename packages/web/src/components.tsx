/**
 * UIClaw Component Library
 * 
 * Renders UI specs into React components.
 * All components are dark-mode native.
 */

export type UIComponent = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export function RenderComponent({ component }: { component: UIComponent }) {
  switch (component.type) {
    case "Stack":
      return <StackComponent component={component} />;
    case "Columns":
      return <ColumnsComponent component={component} />;
    case "Markdown":
      return <MarkdownComponent component={component} />;
    case "Card":
      return <CardComponent component={component} />;
    case "DataTable":
      return <DataTableComponent component={component} />;
    case "Canvas":
      return <CanvasComponent component={component} />;
    case "ImageGrid":
      return <ImageGridComponent component={component} />;
    case "ColorPalette":
      return <ColorPaletteComponent component={component} />;
    case "LogView":
      return <LogViewComponent component={component} />;
    default:
      return (
        <div className="p-3 bg-slate-800/20 rounded-lg text-xs text-slate-500">
          Unknown component: {component.type}
        </div>
      );
  }
}

// ─── Stack ───────────────────────────────────────────────────
function StackComponent({ component }: { component: UIComponent }) {
  const direction = (component.direction as string) ?? "vertical";
  const gap = (component.gap as number) ?? 16;
  const children = (component.children as UIComponent[]) ?? [];
  return (
    <div className={`flex ${direction === "horizontal" ? "flex-row" : "flex-col"}`} style={{ gap }}>
      {children.map((child) => (
        <RenderComponent key={child.id} component={child} />
      ))}
    </div>
  );
}

// ─── Columns ─────────────────────────────────────────────────
function ColumnsComponent({ component }: { component: UIComponent }) {
  const columns = (component.columns as UIComponent[]) ?? [];
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
      {columns.map((col) => (
        <RenderComponent key={col.id} component={col} />
      ))}
    </div>
  );
}

// ─── Markdown ────────────────────────────────────────────────
function MarkdownComponent({ component }: { component: UIComponent }) {
  const content = String(component.content ?? "");
  
  // Process code blocks first — replace with placeholders, render separately
  const codeBlocks: string[] = [];
  let processed = content.replace(/```(\w*)\n([\s\S]*?)```/gm, (_match, lang, code) => {
    const escaped = code.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<div class="my-3 bg-slate-900/80 border border-slate-700/50 rounded-lg overflow-hidden">` +
      (lang ? `<div class="px-3 py-1.5 text-[10px] text-slate-500 border-b border-slate-700/50 font-mono">${lang}</div>` : "") +
      `<pre class="p-3 overflow-x-auto text-[13px] leading-relaxed font-mono text-slate-300 m-0"><code>${escaped}</code></pre></div>`
    );
    return `__CODE_BLOCK_${idx}__`;
  });
  
  // Markdown transforms
  processed = processed
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold text-slate-200 mt-4 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-bold text-slate-100 mt-5 mb-3">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold text-white mt-6 mb-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-slate-100">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 bg-slate-800 rounded text-amber-300 text-xs font-mono">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-sky-400 hover:text-sky-300 underline">$1</a>')
    .replace(/^[-*•] (.+)$/gm, '<div class="flex gap-2 ml-2"><span class="text-slate-500">•</span><span class="text-slate-300">$1</span></div>')
    .replace(/^\d+\.\s+(.+)$/gm, '<div class="ml-2 text-slate-300">$1</div>')
    .replace(/\n\n/g, '<div class="h-3"></div>')
    .replace(/\n/g, "<br />");
  
  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i]);
  }

  return (
    <div
      className="prose prose-invert max-w-none text-slate-300 text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: processed }}
    />
  );
}

// ─── Card ────────────────────────────────────────────────────
function CardComponent({ component }: { component: UIComponent }) {
  const title = String(component.title ?? "");
  const content = String(component.content ?? "");
  const icon = component.icon as string | undefined;
  const url = component.url as string | undefined;

  const inner = (
    <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl p-4 hover:border-slate-600/50 transition-all">
      <div className="flex items-start gap-3">
        {icon && <span className="text-xl">{icon}</span>}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-slate-200 mb-1">{title}</h3>
          <p className="text-xs text-slate-400 leading-relaxed">{content}</p>
        </div>
      </div>
    </div>
  );

  if (url) {
    return <a href={url} target="_blank" rel="noopener noreferrer" className="block">{inner}</a>;
  }
  return inner;
}

// ─── DataTable ───────────────────────────────────────────────
function DataTableComponent({ component }: { component: UIComponent }) {
  const columns = (component.columns as string[]) ?? [];
  const rows = (component.rows as string[][]) ?? [];

  return (
    <div className="bg-slate-800/20 border border-slate-700/50 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800/50">
              {columns.map((col, i) => (
                <th key={i} className="px-4 py-2.5 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/30">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-slate-800/20 transition-colors">
                {row.map((cell, j) => (
                  <td key={j} className="px-4 py-2.5 text-slate-300">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Canvas ──────────────────────────────────────────────────
function CanvasComponent({ component }: { component: UIComponent }) {
  const rawHtml = String(component.html ?? "");
  const height = Number(component.height ?? 400);
  const title = component.title as string | undefined;

  const darkStyles = `<style>body{background:#1e293b!important;color:#e2e8f0!important;font-family:system-ui,sans-serif;margin:0;padding:16px;} a{color:#38bdf8!important;} h1,h2,h3{color:#f1f5f9!important;}</style>`;
  // Inject a postMessage bridge so Canvas HTML can send data back to the app
  const bridge = `<script>
    function sendToApp(type, data) {
      window.parent.postMessage({ source: 'uiclaw-canvas', type, data }, '*');
    }
  </script>`;
  const html = rawHtml.includes("<head>")
    ? rawHtml.replace("<head>", `<head>${darkStyles}${bridge}`)
    : `<html><head>${darkStyles}${bridge}</head><body>${rawHtml}</body></html>`;

  return (
    <div className="bg-slate-800/30 border border-slate-700/50 rounded-xl overflow-hidden">
      {title && (
        <div className="px-4 py-2 border-b border-slate-700/50 text-xs font-medium text-slate-400">
          {title}
        </div>
      )}
      <iframe
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin"
        title={title ?? "Canvas"}
        style={{ width: "100%", height, border: "none", display: "block" }}
      />
    </div>
  );
}

// ─── ImageGrid ───────────────────────────────────────────────
function ImageGridComponent({ component }: { component: UIComponent }) {
  const images = (component.images as Array<{ url?: string; src?: string; caption?: string; alt?: string }>) ?? [];
  // Accept common image extensions, data URIs, and known image CDNs (DALL-E, oaidalleapiprodscus, etc.)
  const isImageUrl = (url: string) => 
    /\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(url) ||
    url.startsWith("data:image/") ||
    url.includes("oaidalleapi") ||
    url.includes("openai.com") ||
    url.includes("blob.core.windows.net") ||
    url.includes("githubusercontent.com") ||
    url.includes("cloudflare") ||
    url.includes("imgur.com") ||
    (url.startsWith("http") && !url.includes(" ")); // Fallback: treat any clean URL as potential image

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {images.map((image, i) => {
        const imgUrl = image.url ?? image.src ?? "";
        const caption = image.caption ?? image.alt ?? "";
        return (
        <div key={i} className="bg-slate-800/30 border border-slate-700/50 rounded-xl overflow-hidden hover:border-sky-500/50 transition-all">
          {isImageUrl(imgUrl) ? (
            <div className="aspect-square overflow-hidden bg-slate-900/50">
              <img
                src={imgUrl}
                alt={caption}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                  (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="w-full h-full flex items-center justify-center text-4xl text-slate-600">🖼️</div>`;
                }}
              />
            </div>
          ) : (
            <a href={imgUrl} target="_blank" rel="noopener noreferrer" className="block p-4 hover:bg-slate-700/30 transition-colors">
              <div className="flex items-center gap-3">
                <div className="text-2xl">🔗</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-300 truncate">{caption || imgUrl}</div>
                  <div className="text-xs text-slate-500 truncate">{(() => { try { return new URL(imgUrl).hostname; } catch { return imgUrl; } })()}</div>
                </div>
                <div className="text-slate-500">↗</div>
              </div>
            </a>
          )}
          {caption && isImageUrl(imgUrl) && (
            <div className="p-3 text-sm text-slate-300 border-t border-slate-700/50">{caption}</div>
          )}
        </div>
      );
      })}
    </div>
  );
}

// ─── ColorPalette ────────────────────────────────────────────
function ColorPaletteComponent({ component }: { component: UIComponent }) {
  const colors = (component.colors as Array<{ hex: string; name?: string }>) ?? [];
  return (
    <div className="flex flex-wrap gap-3">
      {colors.map((color, i) => (
        <div key={i} className="flex flex-col items-center gap-1">
          <div
            className="w-14 h-14 rounded-xl border border-slate-700/50 shadow-lg"
            style={{ backgroundColor: color.hex }}
          />
          <span className="text-[10px] text-slate-400">{color.name ?? color.hex}</span>
        </div>
      ))}
    </div>
  );
}

// ─── LogView ─────────────────────────────────────────────────
function LogViewComponent({ component }: { component: UIComponent }) {
  const logs = (component.logs as string[]) ?? [];
  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded-xl p-3 font-mono text-xs">
      {logs.map((log, i) => (
        <div key={i} className="text-slate-400 py-0.5">{log}</div>
      ))}
    </div>
  );
}
