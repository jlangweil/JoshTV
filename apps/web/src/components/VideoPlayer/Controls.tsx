import { useRef } from "react";
import { SeekBar } from "./SeekBar";
import { ReactionBar } from "../Reactions/ReactionBar";
import { PLAYBACK_SPEEDS } from "../../types";

interface Props {
  isHost: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  speed: number;
  canPlay: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onMute: () => void;
  onSpeed: (s: number) => void;
  onFullscreen: () => void;
  onPip: () => void;
  onCaptionFile: (file: File) => void;
  onReact: (emoji: string) => void;
  onRequestPause: () => void;
  onToggleChat: () => void;
  unreadCount: number;
}

export function Controls(p: Props) {
  const captionInput = useRef<HTMLInputElement>(null);

  const btn =
    "rounded-lg px-2 py-1 text-sm font-medium text-cinema-text/90 hover:bg-cinema-surface focus:outline-none focus:ring-2 focus:ring-cinema-accent transition-colors";

  return (
    <div className="flex flex-col gap-2 px-4 pb-3 pt-1">
      <SeekBar currentTime={p.currentTime} duration={p.duration} onSeek={p.isHost ? p.onSeek : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        {p.isHost ? (
          <button
            type="button"
            className={`${btn} text-xl`}
            onClick={p.playing ? p.onPause : p.onPlay}
            disabled={!p.playing && !p.canPlay}
            aria-label={p.playing ? "Pause" : "Play"}
            title={!p.playing && !p.canPlay ? "Waiting for all viewers to buffer" : undefined}
          >
            {p.playing ? "⏸" : "▶"}
          </button>
        ) : (
          <button
            type="button"
            className={`${btn} text-lg`}
            onClick={p.onRequestPause}
            aria-label="Request a pause"
            title="Raise a hand to request a pause"
          >
            {"✋"}
          </button>
        )}

        <div className="flex items-center gap-1">
          <button type="button" className={btn} onClick={p.onMute} aria-label={p.muted ? "Unmute" : "Mute"}>
            {p.muted ? "\u{1F507}" : "\u{1F50A}"}
          </button>
          <input
            type="range"
            className="seek-range w-20"
            min={0}
            max={1}
            step={0.05}
            value={p.muted ? 0 : p.volume}
            aria-label="Volume"
            onChange={(e) => p.onVolume(Number(e.target.value))}
          />
        </div>

        {p.isHost ? (
          <select
            className="rounded-lg border border-cinema-surface bg-cinema-panel px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-cinema-accent"
            value={p.speed}
            aria-label="Playback speed"
            onChange={(e) => p.onSpeed(Number(e.target.value))}
          >
            {PLAYBACK_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-xs text-cinema-muted">{p.speed}x</span>
        )}

        <div className="grow" />

        <ReactionBar onReact={p.onReact} />

        {p.isHost && (
          <>
            <button
              type="button"
              className={btn}
              onClick={() => captionInput.current?.click()}
              aria-label="Load subtitles"
              title="Load .vtt or .srt subtitles"
            >
              CC
            </button>
            <input
              ref={captionInput}
              type="file"
              accept=".vtt,.srt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) p.onCaptionFile(f);
                e.target.value = "";
              }}
            />
          </>
        )}

        <button type="button" className={btn} onClick={p.onPip} aria-label="Picture in picture">
          PiP
        </button>
        <button type="button" className={btn} onClick={p.onToggleChat} aria-label="Toggle chat">
          {"\u{1F4AC}"}
          {p.unreadCount > 0 && (
            <span className="ml-1 rounded-full bg-cinema-accent px-1.5 text-xs text-white">{p.unreadCount}</span>
          )}
        </button>
        <button type="button" className={btn} onClick={p.onFullscreen} aria-label="Toggle fullscreen">
          {"⛶"}
        </button>
      </div>
    </div>
  );
}
