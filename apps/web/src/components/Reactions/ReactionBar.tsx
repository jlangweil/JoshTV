import { REACTION_EMOJIS } from "../../types";

export function ReactionBar({ onReact }: { onReact: (emoji: string) => void }) {
  return (
    <div className="flex gap-1" role="group" aria-label="Send a reaction">
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onReact(emoji)}
          aria-label={`React with ${emoji}`}
          className="touch-target rounded-lg px-1.5 py-0.5 text-lg hover:bg-cinema-surface focus:outline-none focus:ring-2 focus:ring-cinema-accent transition-colors"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
