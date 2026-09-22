import { RoomUser, GuestBufferState } from "../../types";
import { GuestList } from "./GuestList";

interface Props {
  isHost: boolean;
  users: RoomUser[];
  bufferStates: Record<string, GuestBufferState>;
  onPickFile?: (file: File) => void;
}

/** RM-06: shown until the host loads a file. */
export function RoomLobby({ isHost, users, bufferStates, onPickFile }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="animate-bounce text-6xl" aria-hidden="true">
        {"\u{1F37F}"}
      </div>
      {isHost ? (
        <label
          className="flex w-full max-w-xl cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-cinema-surface p-10 transition-colors hover:border-cinema-accent focus-within:border-cinema-accent"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f && onPickFile) onPickFile(f);
          }}
        >
          <span className="font-display text-2xl">Drop your MP4 here or click to browse</span>
          <span className="text-sm text-cinema-muted">
            The file never leaves your browser except as encrypted peer-to-peer chunks. Viewers who already have it can play their own copy instead.
          </span>
          <input
            type="file"
            accept="video/mp4,video/webm"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f && onPickFile) onPickFile(f);
              e.target.value = "";
            }}
            aria-label="Choose a video file"
          />
        </label>
      ) : (
        <p className="font-display text-2xl text-cinema-text/90">Waiting for the host to load a movie…</p>
      )}
      <GuestList users={users} bufferStates={bufferStates} showBufferDots={isHost} />
    </div>
  );
}
