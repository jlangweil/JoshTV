import { useEffect, useRef, useState } from "react";
import { REACTION_EMOJIS } from "../../types";

const EMOJI_BUTTON =
  "touch-target rounded-lg px-1.5 py-0.5 text-lg hover:bg-cinema-surface focus:outline-none focus:ring-2 focus:ring-cinema-accent transition-colors";

/**
 * The five reaction buttons, or — when the controls bar is narrow (chat open
 * on a small screen) — one button that opens them, so the controls stay on a
 * single row and the picture keeps its height.
 */
export function ReactionBar({ onReact, compact = false }: { onReact: (emoji: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const buttons = REACTION_EMOJIS.map((emoji) => (
    <button
      key={emoji}
      type="button"
      onClick={() => {
        onReact(emoji);
        setOpen(false);
      }}
      aria-label={`React with ${emoji}`}
      className={EMOJI_BUTTON}
    >
      {emoji}
    </button>
  ));

  if (!compact) {
    return (
      <div className="flex gap-1" role="group" aria-label="Send a reaction">
        {buttons}
      </div>
    );
  }
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={EMOJI_BUTTON}
        onClick={() => setOpen((o) => !o)}
        aria-label="Reactions"
        aria-expanded={open}
      >
        {"\u{1F60A}"}
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 z-30 mb-2 flex gap-1 rounded-xl border border-cinema-surface bg-cinema-panel p-1 shadow-xl"
          role="group"
          aria-label="Send a reaction"
        >
          {buttons}
        </div>
      )}
    </div>
  );
}
