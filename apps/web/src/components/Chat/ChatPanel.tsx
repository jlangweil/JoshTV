import { ChatMessage, RoomUser } from "../../types";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";

interface Props {
  messages: ChatMessage[];
  users: RoomUser[];
  roomId: string;
  onSend: (text: string) => void;
  /** Fullscreen renders the panel as a slide-over (CH-08/FS-02). */
  overlay: boolean;
  open: boolean;
  onClose: () => void;
}

export function ChatPanel({ messages, users, roomId, onSend, overlay, open, onClose }: Props) {
  if (!open) return null;
  const guestCount = users.filter((u) => !u.isHost).length;

  return (
    <aside
      className={
        overlay
          ? "absolute inset-y-0 right-0 z-30 flex w-80 max-w-[85vw] flex-col border-l border-cinema-surface bg-cinema-panel/95 backdrop-blur transition-transform"
          : "flex h-full w-80 shrink-0 flex-col border-l border-cinema-surface bg-cinema-panel max-lg:w-full max-lg:border-l-0 max-lg:border-t"
      }
      aria-label="Chat"
    >
      <header className="flex items-center justify-between border-b border-cinema-surface px-3 py-2">
        <div>
          <span className="font-mono text-sm font-semibold tracking-widest text-cinema-accent">ROOM: {roomId}</span>
          <span className="ml-2 text-xs text-cinema-muted" aria-label={`${guestCount} viewers`}>
            {"\u{1F464}"} {guestCount} viewer{guestCount === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          className="touch-target rounded px-2 py-0.5 text-cinema-muted hover:bg-cinema-surface hover:text-cinema-text"
          onClick={onClose}
          aria-label="Collapse chat"
        >
          ✕
        </button>
      </header>
      <MessageList messages={messages} userNames={users.map((u) => u.name)} />
      <MessageInput onSend={onSend} />
    </aside>
  );
}
