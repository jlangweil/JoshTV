import { Reaction } from "../../types";

function laneFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 8 + (h % 80); // percent from left
}

/** RC-01/RC-02: emoji that float up over the video for everyone. */
export function ReactionOverlay({ reactions }: { reactions: Reaction[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {reactions.map((r) => (
        <div
          key={r.id}
          className="reaction-float absolute bottom-4 flex flex-col items-center"
          style={{ left: `${laneFor(r.id)}%` }}
        >
          <span className="text-4xl drop-shadow">{r.emoji}</span>
          <span className="text-xs text-cinema-text/70 font-medium">{r.user}</span>
        </div>
      ))}
    </div>
  );
}
