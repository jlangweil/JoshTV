import { useEffect, useRef } from "react";
import { ChatMessage } from "../../types";

function renderText(text: string, names: string[]) {
  // CH-03: highlight @mentions of present users.
  const parts = text.split(/(@[\w-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@") && names.includes(part.slice(1).toLowerCase())) {
      return (
        <span key={i} className="rounded bg-cinema-accent/20 px-0.5 font-semibold text-cinema-accent">
          {part}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function MessageList({ messages, userNames }: { messages: ChatMessage[]; userNames: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lowerNames = userNames.map((n) => n.toLowerCase());

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={ref}
      className="flex-1 space-y-2 overflow-y-auto px-3 py-2"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      role="log"
      aria-label="Chat messages"
    >
      {messages.map((m) =>
        m.system ? (
          // CH-07: system messages styled differently.
          <div key={m.id} className="text-center text-xs italic text-cinema-muted">
            {m.text}
          </div>
        ) : (
          <div key={m.id} className="text-sm leading-snug">
            <span className="mr-1 font-semibold" style={{ color: m.color }}>
              {m.user}
            </span>
            <span className="mr-1 font-mono text-[10px] text-cinema-muted">
              {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
            <div className="break-words text-cinema-text/90">{renderText(m.text, lowerNames)}</div>
          </div>
        )
      )}
    </div>
  );
}
