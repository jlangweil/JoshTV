import { useEffect, useRef, useState } from "react";
import { copyText, roomLink } from "../../lib/invite";

type Status = "idle" | "copied" | "failed";

function useCopy(roomId: string) {
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const ok = await copyText(roomLink(roomId));
    setStatus(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2500);
    return ok;
  };
  return { status, copy };
}

/** Compact header button: copies the room's invite link. */
export function CopyLinkButton({ roomId }: { roomId: string }) {
  const { status, copy } = useCopy(roomId);
  return (
    <button
      type="button"
      className="touch-target rounded-lg bg-cinema-surface px-2 py-1 text-xs hover:bg-cinema-surface/70 focus:outline-none focus:ring-2 focus:ring-cinema-accent"
      onClick={async () => {
        // Last resort: show the link so it can be copied by hand.
        if (!(await copy())) window.prompt("Copy this invite link:", roomLink(roomId));
      }}
      title={roomLink(roomId)}
      aria-live="polite"
    >
      {status === "copied" ? "Link copied!" : "Copy invite link"}
    </button>
  );
}

/** Lobby card: the full link, selectable, with a copy button. */
export function InvitePanel({ roomId }: { roomId: string }) {
  const { status, copy } = useCopy(roomId);
  const inputRef = useRef<HTMLInputElement>(null);
  const link = roomLink(roomId);
  return (
    <div className="flex w-full max-w-xl flex-col gap-2 rounded-2xl border border-cinema-surface bg-cinema-panel p-4 text-left">
      <span className="text-sm text-cinema-muted">
        Invite friends: send them this link (or the code{" "}
        <span className="font-mono tracking-widest text-cinema-text">{roomId}</span>)
      </span>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 grow rounded-lg border border-cinema-surface bg-cinema-bg px-3 py-2 font-mono text-sm"
          aria-label="Invite link"
        />
        <button
          type="button"
          className="shrink-0 rounded-lg bg-cinema-accent px-4 py-2 text-sm font-semibold text-white hover:bg-cinema-accent/80"
          onClick={async () => {
            if (!(await copy())) inputRef.current?.select();
          }}
          aria-live="polite"
        >
          {status === "copied" ? "Copied!" : status === "failed" ? "Press Ctrl+C" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
