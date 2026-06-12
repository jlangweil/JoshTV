import { RoomUser, GuestBufferState } from "../../types";
import { bufferHealth } from "../../lib/sync";

const DOT: Record<string, string> = {
  green: "bg-green-400",
  yellow: "bg-yellow-400",
  red: "bg-red-400",
};

interface Props {
  users: RoomUser[];
  bufferStates: Record<string, GuestBufferState>;
  showBufferDots: boolean;
}

/** RM-09 + BF-03: who's here, with per-guest buffer health for the host. */
export function GuestList({ users, bufferStates, showBufferDots }: Props) {
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="People in this room">
      {users.map((u) => {
        const st = bufferStates[u.id];
        const health = st ? bufferHealth(st.aheadSeconds, st.complete) : "yellow";
        return (
          <li
            key={u.id}
            className="flex items-center gap-1.5 rounded-full bg-cinema-surface px-2 py-1 text-xs"
            title={
              !u.isHost && st
                ? st.complete
                  ? "Fully buffered"
                  : `${st.aheadSeconds.toFixed(1)}s buffered ahead`
                : undefined
            }
          >
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-cinema-bg"
              style={{ backgroundColor: u.color }}
              aria-hidden="true"
            >
              {u.name.charAt(0).toUpperCase()}
            </span>
            <span className="max-w-24 truncate">{u.name}</span>
            {u.isHost && <span className="font-mono text-[9px] uppercase text-cinema-accent">host</span>}
            {!u.isHost && showBufferDots && (
              <span
                className={`h-2 w-2 rounded-full ${DOT[health]}`}
                aria-label={`Buffer status: ${health}`}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
