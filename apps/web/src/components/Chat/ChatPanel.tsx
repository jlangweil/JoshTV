import { useEffect, useRef, useState } from "react";
import { ChatMessage, RoomUser } from "../../types";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";
import { ReactionBar } from "../Reactions/ReactionBar";

interface Props {
  messages: ChatMessage[];
  users: RoomUser[];
  roomId: string;
  onSend: (text: string) => void;
  onReact: (emoji: string) => void;
  open: boolean;
  onClose: () => void;
}

/**
 * Docked beside the picture on landscape/wide screens, below it on portrait
 * ones — never on top, so it can't cover the movie or the controls. The same
 * layout is used in fullscreen, where it's rendered inside the player
 * (CH-08/FS-02), so chat and reactions stay usable there.
 */
export function ChatPanel({ messages, users, roomId, onSend, onReact, open, onClose }: Props) {
  if (!open) return null;

  return (
    <aside
      className={
        // Portrait (narrower than a laptop): full width, a third of the height below the picture.
        "flex h-1/3 min-h-48 w-full shrink-0 flex-col border-t border-cinema-surface bg-cinema-panel " +
        // Landscape or wide: a column beside the picture.
        "landscape:h-full landscape:w-72 landscape:max-w-[35%] landscape:border-l landscape:border-t-0 " +
        "lg:h-full lg:w-72 lg:max-w-[35%] lg:border-l lg:border-t-0"
      }
      aria-label="Chat"
    >
      <header className="flex items-center justify-between gap-2 border-b border-cinema-surface px-3 py-1.5">
        <span className="font-mono text-sm font-semibold tracking-widest text-cinema-accent">{roomId}</span>
        <PeopleButton users={users} />
        <div className="grow" />
        <button
          type="button"
          className="touch-target rounded px-2 py-0.5 text-cinema-muted hover:bg-cinema-surface hover:text-cinema-text"
          onClick={onClose}
          aria-label="Collapse chat"
          title="Hide chat (C)"
        >
          ✕
        </button>
      </header>
      <MessageList messages={messages} userNames={users.map((u) => u.name)} />
      {/* Reactions live with the chat so they're reachable in fullscreen too. */}
      <div className="flex justify-center border-t border-cinema-surface px-2 py-1">
        <ReactionBar onReact={onReact} />
      </div>
      <MessageInput onSend={onSend} />
    </aside>
  );
}

/**
 * "👤 3 watching": hover (desktop) or tap (iPad — no hover there) to see who's
 * connected. Counts the room's live connections, straight from the server.
 */
function PeopleButton({ users }: { users: RoomUser[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const viewers = users.filter((u) => !u.isHost);
  const host = users.find((u) => u.isHost);
  const summary =
    `${host ? `Host: ${host.name}` : "Host: (not connected)"}\n` +
    (viewers.length ? `Watching: ${viewers.map((u) => u.name).join(", ")}` : "No viewers yet");

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="touch-target rounded px-1.5 text-xs text-cinema-muted hover:bg-cinema-surface hover:text-cinema-text"
        onClick={() => setOpen((o) => !o)}
        aria-label={`${viewers.length} watching. Show who's connected`}
        aria-expanded={open}
        title={summary}
      >
        {"\u{1F464}"} {viewers.length} watching
      </button>
      {open && (
        <ul
          className="absolute left-0 top-full z-40 mt-1 max-h-64 w-56 overflow-y-auto rounded-xl border border-cinema-surface bg-cinema-panel p-2 text-sm shadow-xl"
          aria-label="Connected people"
        >
          {[...(host ? [host] : []), ...viewers].map((u) => (
            <li key={u.id} className="flex items-center gap-2 rounded px-1 py-1">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-cinema-bg"
                style={{ backgroundColor: u.color }}
                aria-hidden="true"
              >
                {u.name.charAt(0).toUpperCase()}
              </span>
              <span className="truncate">{u.name}</span>
              {u.isHost && <span className="ml-auto font-mono text-[9px] uppercase text-cinema-accent">host</span>}
            </li>
          ))}
          {!host && <li className="px-1 py-1 text-xs text-cinema-muted">The host isn't connected right now.</li>}
        </ul>
      )}
    </div>
  );
}
