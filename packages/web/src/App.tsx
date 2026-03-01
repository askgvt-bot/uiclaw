import { useState, useEffect, useRef, useCallback } from "react";
import { RenderComponent, type UIComponent } from "./components";

// ─── Types ───────────────────────────────────────────────────
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  streaming?: boolean;
};

type FormSpec = {
  formId: string;
  title: string;
  description?: string;
  fields: Array<{
    id: string;
    label: string;
    type: string;
    placeholder?: string;
    options?: string[];
    required?: boolean;
    default?: any;
  }>;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

type RegistryEntry = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  screenshotFile?: string;
  hasScreenshot?: boolean;
  useCount?: number;
};

type RegistryIndex = {
  version?: string;
  interfaces?: RegistryEntry[];
};

// ─── WebSocket Hook ──────────────────────────────────────────
function useUIClaw() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [uiSpec, setUiSpec] = useState<UIComponent | null>(null);
  const [activeForm, setActiveForm] = useState<FormSpec | null>(null);
  const [agentEvents, setAgentEvents] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setConnectionState("connected");
    ws.onclose = () => {
      setConnectionState("disconnected");
      setTimeout(connect, 3000); // Auto-reconnect
    };
    ws.onerror = () => setConnectionState("error");

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "gateway.connected":
          setConnectionState("connected");
          break;
        case "gateway.disconnected":
          setConnectionState("disconnected");
          break;
        case "chat.delta":
          // Streaming: update or create a streaming message
          setMessages((prev) => {
            const streamId = `stream_${msg.runId}`;
            const existing = prev.findIndex((m) => m.id === streamId);
            const entry = {
              id: streamId,
              role: msg.role ?? "assistant",
              content: msg.content,
              timestamp: new Date().toISOString(),
              streaming: true,
            };
            if (existing >= 0) {
              const updated = [...prev];
              updated[existing] = entry;
              return updated;
            }
            return [...prev, entry];
          });
          setIsLoading(true);
          break;
        case "chat.message":
          setMessages((prev) => {
            // If this is a final message, replace any streaming message
            const filtered = prev.filter((m) => !m.streaming);
            return [
              ...filtered,
              {
                id: `msg_${Date.now()}`,
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp ?? new Date().toISOString(),
              },
            ];
          });
          setIsLoading(false);
          break;
        case "chat.done":
          // Mark streaming complete - finalize any remaining stream messages
          setMessages((prev) =>
            prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
          );
          setIsLoading(false);
          break;
        case "chat.error":
          setMessages((prev) => [
            ...prev,
            {
              id: `err_${Date.now()}`,
              role: "system",
              content: `⚠️ ${msg.error}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          setIsLoading(false);
          break;
        case "chat.history":
          // Load initial history
          if (msg.entries?.length) {
            setMessages(
              msg.entries.map((e: any, i: number) => ({
                id: `hist_${i}`,
                role: e.role ?? "system",
                content: e.content ?? e.text ?? "",
                timestamp: e.timestamp ?? "",
              }))
            );
          }
          break;
        case "ui.update":
        case "ui.replace":
        case "ui.patch":
          setUiSpec(msg.spec);
          setIsLoading(false);
          break;
        case "ui.form":
        case "form.show":
          setActiveForm(msg);
          break;
        case "agent.event":
          setAgentEvents((prev) => [...prev.slice(-50), msg.event]);
          break;
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  // Listen for postMessage from Canvas iframes → forward as canvas.action via WS
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.source !== "uiclaw-canvas") return;
      console.log("[UIClaw] Canvas action received:", e.data);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: "canvas.action",
          actionType: e.data.type,
          data: e.data.data,
        }));
        setIsLoading(true);
        console.log("[UIClaw] Canvas action sent to server");
      } else {
        console.warn("[UIClaw] WS not open, can't send canvas action");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "chat.send", text }));
    setIsLoading(true);
    setMessages((prev) => [
      ...prev,
      {
        id: `user_${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  const submitForm = useCallback((formId: string, values: Record<string, any>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "form.submit", formId, values }));
    setActiveForm(null);
  }, []);

  return { connectionState, messages, uiSpec, activeForm, agentEvents, isLoading, sendMessage, submitForm };
}

// ─── Chat Markdown ───────────────────────────────────────────
function ChatMarkdown({ content }: { content: string }) {
  // Render code blocks, bold, italic, inline code, lists, links in chat bubbles
  const codeBlocks: string[] = [];
  let html = content.replace(/```(\w*)\n([\s\S]*?)```/gm, (_m, lang, code) => {
    const escaped = code.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<div class="my-2 bg-slate-900/60 rounded-lg overflow-hidden">` +
      (lang ? `<div class="px-2 py-1 text-[10px] text-slate-500 border-b border-slate-700/40 font-mono">${lang}</div>` : "") +
      `<pre class="p-2 overflow-x-auto text-xs leading-relaxed font-mono text-slate-300 m-0 whitespace-pre"><code>${escaped}</code></pre></div>`
    );
    return `__CB${idx}__`;
  });

  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 bg-slate-700/50 rounded text-amber-300 text-xs font-mono">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-sky-400 underline">$1</a>')
    .replace(/^[-*•] (.+)$/gm, '<div class="flex gap-1.5 ml-1"><span class="text-slate-500">•</span><span>$1</span></div>')
    .replace(/\n\n/g, '<div class="h-2"></div>')
    .replace(/\n/g, "<br />");

  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`__CB${i}__`, codeBlocks[i]);
  }

  return <div className="leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─── Main App ────────────────────────────────────────────────
export function App() {
  const { connectionState, messages, uiSpec, activeForm, agentEvents, isLoading, sendMessage, submitForm } = useUIClaw();
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState(380);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registryEntries, setRegistryEntries] = useState<RegistryEntry[]>([]);
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [selectedRegistryId, setSelectedRegistryId] = useState<string | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!registryOpen) return;
    let active = true;
    setRegistryLoading(true);
    setRegistryError(null);
    fetch("/api/registry")
      .then((res) => {
        if (!res.ok) throw new Error(`Registry load failed (${res.status})`);
        return res.json();
      })
      .then((data: RegistryIndex | RegistryEntry[]) => {
        if (!active) return;
        if (Array.isArray(data)) setRegistryEntries(data);
        else setRegistryEntries(data.interfaces ?? []);
      })
      .catch((err: Error) => {
        if (!active) return;
        setRegistryError(err.message);
      })
      .finally(() => {
        if (!active) return;
        setRegistryLoading(false);
      });
    return () => { active = false; };
  }, [registryOpen]);

  const filteredRegistry = registryEntries.filter((entry) => {
    if (!registryQuery.trim()) return true;
    const needle = registryQuery.toLowerCase();
    return (
      entry.name?.toLowerCase().includes(needle) ||
      entry.description?.toLowerCase().includes(needle) ||
      entry.tags?.some((tag) => tag.toLowerCase().includes(needle))
    );
  });

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    sendMessage(text);
    setInput("");
  };

  return (
    <div className="h-screen flex flex-col bg-slate-950">
      {/* Header */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-slate-800/50 bg-slate-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
            ✨ UIClaw
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Interface Registry"
              onClick={() => setRegistryOpen((prev) => !prev)}
              aria-pressed={registryOpen}
              className="h-8 w-8 rounded-md bg-slate-800/60 text-slate-300 hover:text-amber-300 hover:bg-slate-800/90 hover:shadow-[0_0_14px_rgba(251,191,36,0.35)] transition-all"
            >
              <span className="text-sm">📚</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <div className={`flex items-center gap-1.5 ${
            connectionState === "connected" ? "text-emerald-400" : "text-red-400"
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${
              connectionState === "connected" ? "bg-emerald-400" : "bg-red-400"
            }`} />
            {connectionState === "connected" ? "Connected" : connectionState}
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat panel */}
        <div className="flex flex-col border-r border-slate-800/50" style={{ width: chatWidth }}>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && (
              <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                <div className="text-center space-y-2">
                  <div className="text-4xl">✨</div>
                  <p>Send a message to get started</p>
                </div>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-indigo-600/40 text-slate-200"
                    : "bg-slate-800/60 text-slate-300"
                }`}>
                  <ChatMarkdown content={msg.content} />
                  <div className="text-[10px] text-slate-500 mt-1">
                    {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ""}
                  </div>
                </div>
              </div>
            ))}

            {/* Agent events */}
            {agentEvents.slice(-3).map((evt, i) => (
              <div key={`evt_${i}`} className="flex items-center gap-2 text-xs text-slate-500">
                <span className="text-amber-500">⚡</span>
                <span>{evt.type ?? "event"}</span>
              </div>
            ))}

            <div ref={chatEndRef} />
          </div>

          {/* Active form */}
          {activeForm && (
            <FormPanel form={activeForm} onSubmit={(values) => submitForm(activeForm.formId, values)} />
          )}

          {/* Input */}
          <div className="p-3 border-t border-slate-800/50">
            <div className="flex items-center gap-2 bg-slate-800/40 rounded-xl px-3 py-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                placeholder="Type a message..."
                className="flex-1 bg-transparent outline-none text-sm text-slate-200 placeholder:text-slate-500"
              />
              <button onClick={handleSend} className="text-amber-400 hover:text-amber-300 transition-colors">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          </div>
        </div>

        {/* Workspace panel */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {isLoading && (
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm z-10 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{animationDelay: '0ms'}} />
                  <div className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{animationDelay: '150ms'}} />
                  <div className="w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{animationDelay: '300ms'}} />
                </div>
                <span className="text-sm text-slate-400">Building UI...</span>
              </div>
            </div>
          )}
          <div className="flex-1 p-6 overflow-auto">
            {uiSpec ? (
              <div className="space-y-4 animate-fadeIn">
                <RenderComponent component={uiSpec} />
              </div>
            ) : (
              <WelcomeScreen onExample={sendMessage} />
            )}
          </div>
          <RegistryBrowser
            isOpen={registryOpen}
            entries={filteredRegistry}
            loading={registryLoading}
            error={registryError}
            searchValue={registryQuery}
            onSearchChange={setRegistryQuery}
            selectedId={selectedRegistryId}
            onClose={() => setRegistryOpen(false)}
            onSelect={(entry) => {
              setSelectedRegistryId(entry.id);
              sendMessage(`Load interface: ${entry.name}`);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Registry Browser ────────────────────────────────────────
function RegistryBrowser({
  isOpen,
  entries,
  loading,
  error,
  searchValue,
  onSearchChange,
  selectedId,
  onClose,
  onSelect,
}: {
  isOpen: boolean;
  entries: RegistryEntry[];
  loading: boolean;
  error: string | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  selectedId: string | null;
  onClose: () => void;
  onSelect: (entry: RegistryEntry) => void;
}) {
  return (
    <div className={`absolute inset-0 z-20 ${isOpen ? "pointer-events-auto" : "pointer-events-none"}`}>
      <div
        className={`absolute inset-0 bg-slate-950/40 backdrop-blur-sm transition-opacity ${
          isOpen ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`absolute top-0 right-0 h-full w-[500px] max-w-full bg-slate-950 border-l border-slate-800/70 shadow-2xl transition-transform duration-300 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800/70 bg-slate-900/80">
          <div className="text-sm font-semibold text-slate-200">Interface Registry</div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 inline-flex items-center justify-center rounded-lg bg-slate-800/40 border border-slate-700/60 text-slate-300 hover:text-amber-300 hover:border-amber-400/70 transition"
            aria-label="Close registry"
          >
            ✕
          </button>
        </div>
        <div className="p-4 border-b border-slate-800/60">
          <div className="flex items-center gap-2 bg-slate-900/60 border border-slate-800/70 rounded-xl px-3 py-2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" className="text-slate-500">
              <path d="M10 2a8 8 0 1 0 5.29 14.02l4.35 4.34a1 1 0 0 0 1.42-1.41l-4.35-4.35A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z" />
            </svg>
            <input
              type="text"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search interfaces, tags, descriptions"
              className="flex-1 bg-transparent outline-none text-sm text-slate-200 placeholder:text-slate-500"
            />
          </div>
        </div>
        <div className="p-4 overflow-y-auto h-[calc(100%-128px)]">
          {loading && (
            <div className="text-sm text-slate-400">Loading registry...</div>
          )}
          {!loading && error && (
            <div className="text-sm text-red-400">{error}</div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="text-sm text-slate-500">No interfaces match that search.</div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {entries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => onSelect(entry)}
                className={`text-left bg-slate-900/60 border rounded-xl p-3 space-y-2 transition ${
                  selectedId === entry.id
                    ? "border-amber-400/70 shadow-[0_0_18px_rgba(251,191,36,0.25)]"
                    : "border-slate-800/70 hover:border-amber-400/50"
                }`}
              >
                <div className="aspect-[4/3] bg-slate-900/80 rounded-lg overflow-hidden border border-slate-800/70">
                  {entry.screenshotFile ? (
                    <img src={entry.screenshotFile} alt={entry.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-slate-500">
                      No screenshot
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-200">{entry.name}</div>
                  <div className="text-[10px] uppercase tracking-wider px-2 py-1 rounded-full bg-slate-800/60 text-amber-300/90">
                    Use Count {entry.useCount ?? 0}
                  </div>
                </div>
                {entry.description && (
                  <div
                    className="text-xs text-slate-400"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                    }}
                  >
                    {entry.description}
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {(entry.tags ?? []).map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800/80 text-slate-300"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ─── Welcome Screen ──────────────────────────────────────────
const EXAMPLES = [
  { icon: "🔍", text: "Research the top AI startups in 2026" },
  { icon: "📊", text: "Compare React vs Vue vs Svelte" },
  { icon: "✉️", text: "Draft a cold outreach email" },
  { icon: "🎨", text: "Design a logo for my coffee shop" },
  { icon: "📝", text: "Create a project timeline" },
  { icon: "💡", text: "Brainstorm product names for a fitness app" },
];

function WelcomeScreen({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center">
      <div className="max-w-2xl mx-auto text-center space-y-8">
        <div className="space-y-4">
          <div className="text-6xl mb-4 animate-pulse">✨</div>
          <h1 className="text-3xl font-bold text-slate-200">What would you like to do?</h1>
          <p className="text-slate-400 text-lg">Choose an example or describe your own task</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.text}
              onClick={() => onExample(ex.text)}
              className="p-4 bg-slate-800/30 border border-slate-700/50 rounded-xl text-left hover:border-amber-500/50 hover:bg-slate-800/50 transition-all group"
            >
              <div className="text-2xl mb-2">{ex.icon}</div>
              <div className="text-sm text-slate-300 group-hover:text-slate-200">{ex.text}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Form Panel ──────────────────────────────────────────────
function FormPanel({ form, onSubmit }: { form: FormSpec; onSubmit: (values: Record<string, any>) => void }) {
  const [values, setValues] = useState<Record<string, any>>({});

  const setValue = (id: string, value: any) => setValues((prev) => ({ ...prev, [id]: value }));

  return (
    <div className="p-3 border-t border-slate-800/50 bg-slate-900/50 space-y-3 max-h-[50%] overflow-auto">
      <h3 className="text-sm font-semibold text-slate-200">{form.title}</h3>
      {form.description && <p className="text-xs text-slate-400">{form.description}</p>}
      {form.fields.map((field) => (
        <div key={field.id} className="space-y-1">
          <label className="text-xs text-slate-400">{field.label}</label>
          {field.type === "select" ? (
            <select
              value={values[field.id] ?? field.default ?? ""}
              onChange={(e) => setValue(field.id, e.target.value)}
              className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-200"
            >
              <option value="">Select...</option>
              {field.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : field.type === "textarea" ? (
            <textarea
              value={values[field.id] ?? ""}
              onChange={(e) => setValue(field.id, e.target.value)}
              placeholder={field.placeholder}
              className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-200 min-h-[60px]"
            />
          ) : field.type === "checkbox" ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={values[field.id] ?? false}
                onChange={(e) => setValue(field.id, e.target.checked)}
                className="rounded"
              />
              <span className="text-sm text-slate-300">{field.label}</span>
            </label>
          ) : (
            <input
              type={field.type}
              value={values[field.id] ?? ""}
              onChange={(e) => setValue(field.id, e.target.value)}
              placeholder={field.placeholder}
              className="w-full bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-1.5 text-sm text-slate-200"
            />
          )}
        </div>
      ))}
      <button
        onClick={() => onSubmit(values)}
        className="w-full py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded-lg text-sm font-medium transition-colors"
      >
        Submit
      </button>
    </div>
  );
}
