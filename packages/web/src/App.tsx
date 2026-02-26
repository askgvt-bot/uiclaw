import { useState, useEffect, useRef, useCallback } from "react";
import { RenderComponent, type UIComponent } from "./components";

// ─── Types ───────────────────────────────────────────────────
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
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

// ─── WebSocket Hook ──────────────────────────────────────────
function useUIClaw() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [uiSpec, setUiSpec] = useState<UIComponent | null>(null);
  const [activeForm, setActiveForm] = useState<FormSpec | null>(null);
  const [agentEvents, setAgentEvents] = useState<any[]>([]);

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
        case "chat.message":
          setMessages((prev) => [
            ...prev,
            {
              id: `msg_${Date.now()}`,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp,
            },
          ]);
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
          setUiSpec(msg.spec);
          break;
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

  const sendMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "chat.send", text }));
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

  return { connectionState, messages, uiSpec, activeForm, agentEvents, sendMessage, submitForm };
}

// ─── Main App ────────────────────────────────────────────────
export function App() {
  const { connectionState, messages, uiSpec, activeForm, agentEvents, sendMessage, submitForm } = useUIClaw();
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatWidth, setChatWidth] = useState(380);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
                  <div className="whitespace-pre-wrap">{msg.content}</div>
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
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 p-6 overflow-auto">
            {uiSpec ? (
              <div className="space-y-4 animate-fadeIn">
                <RenderComponent component={uiSpec} />
              </div>
            ) : (
              <WelcomeScreen onExample={sendMessage} />
            )}
          </div>
        </div>
      </div>
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
