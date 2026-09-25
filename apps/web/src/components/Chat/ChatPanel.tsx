import { ChatMessage, RoomUser } from "../../types";
import { MessageList } from "./MessageList";
import { MessageInput } from "./MessageInput";

interface Props {
  messages: ChatMessage[];
  users: RoomUser[];
  roomId: string;
  onSend: (text: string) => void;
  open: boolean;
  onClose: () => void;
}

/**
 * Docked beside the picture on landscape/wide screens, below it on portrait
 * ones — never on top, so it can't cover the movie or the controls. The same
 * layout is used in fullscreen, where it's rendered inside the player (CH-08/FS-02).
 */
export function ChatPanel({ messages, users, roomId, onSend, open, onClose }: Props) {
  if (!open) return null;
  const guestCount = users.filter((u) => !u.isHost).length;

  return (
    <aside
      className={
        // Portrait (narrower than a laptop): full width, 40% of the height below the picture.
        "flex h-2/5 min-h-48 w-full shrink-0 flex-col border-t border-cinema-surface bg-cinema-panel " +
        // Landscape or wide: a column beside the picture.
        "landscape:h-full landscape:w-80 landscape:max-w-[40%] landscape:border-l landscape:border-t-0 " +
        "lg:h-full lg:w-80 lg:max-w-[40%] lg:border-l lg:border-t-0"
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
