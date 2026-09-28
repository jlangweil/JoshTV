import { useLayoutEffect, useRef, useState } from "react";
import { SeekBar } from "./SeekBar";
import { PLAYBACK_SPEEDS } from "../../types";
import { canSetVolume, isIOS } from "../../lib/platform";

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
  onRequestPause: () => void;
  onToggleChat: () => void;
  unreadCount: number;
}


export function Controls(p: Props) {
  const captionInput = useRef<HTMLInputElement>(null);
  // Compact (no volume slider, no PiP button) exactly when the
  // full set of buttons wouldn't fit on one row — measured, not a media query,
  // since the chat narrows the player on any screen. Keeping one row keeps the
  // picture as tall as possible.
  const rowRef = useRef<HTMLDivElement>(null);
  const fullWidthRef = useRef(0);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  compactRef.current = compact;
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      if (!compactRef.current) {
        // Natural width of the full layout (spacer excluded), wrapped or not.
        const kids = [...row.children] as HTMLElement[];
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        fullWidthRef.current =
          kids.reduce((sum, k) => sum + (k.dataset.spacer ? 0 : k.offsetWidth), 0) + gap * (kids.length - 1);
      }
      const next = row.clientWidth < fullWidthRef.current;
      if (next !== compactRef.current) setCompact(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [compact, p.isHost]);

  const btn =
    "touch-target rounded-lg px-2 py-1 text-sm font-medium text-cinema-text/90 hover:bg-cinema-surface focus:outline-none focus:ring-2 focus:ring-cinema-accent transition-colors";

  return (
    <div className="safe-bottom flex flex-col gap-2 px-4 pb-3 pt-1">
      <SeekBar currentTime={p.currentTime} duration={p.duration} onSeek={p.isHost ? p.onSeek : undefined} />
      <div ref={rowRef} className="flex flex-wrap items-center gap-2">
        {p.isHost ? (
          <button
            type="button"
            className={`${btn} text-xl`}
            onClick={p.playing ? p.onPause : p.onPlay}
            disabled={!p.playing && !p.canPlay}
            aria-label={p.playing ? "Pause" : "Play"}
            title={
              p.playing
                ? "Pause for everyone (Space)"
                : p.canPlay
                  ? "Play for everyone (Space)"
                  : "Load a video first"
            }
          >
            {p.playing ? "⏸" : "▶"}
          </button>
        ) : (
          <button
            type="button"
            className={`${btn} text-lg`}
            onClick={p.onRequestPause}
            aria-label="Request a pause"
            title="Ask the host to pause"
          >
            {"✋"}
          </button>
        )}

        <div className="flex items-center gap-1">
          <button
            type="button"
            className={btn}
            onClick={p.onMute}
            aria-label={p.muted ? "Unmute" : "Mute"}
            title={p.muted ? "Unmute (just for you)" : "Mute (just for you)"}
            data-audio-control
          >
            {p.muted ? "\u{1F507}" : "\u{1F50A}"}
          </button>
          {/* iOS ignores programmatic volume — hardware buttons only. */}
          {canSetVolume && !compact && (
            <input
              type="range"
              className="seek-range w-20"
              min={0}
              max={1}
              step={0.05}
              value={p.muted ? 0 : p.volume}
              aria-label="Volume"
              title="Volume (just for you)"
              data-audio-control
              onChange={(e) => p.onVolume(Number(e.target.value))}
            />
          )}
        </div>

        {p.isHost ? (
          <select
            className="touch-target rounded-lg border border-cinema-surface bg-cinema-panel px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-cinema-accent"
            value={p.speed}
            aria-label="Playback speed"
            title="Playback speed for everyone"
            onChange={(e) => p.onSpeed(Number(e.target.value))}
          >
            {PLAYBACK_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        ) : (
          <span className="font-mono text-xs text-cinema-muted" title="Playback speed (set by the host)">
            {p.speed}x
          </span>
        )}

        <div className="grow" data-spacer />


        {p.isHost && (
          <>
            <button
              type="button"
              className={btn}
              onClick={() => captionInput.current?.click()}
              aria-label="Load subtitles"
              title="Load subtitles (.srt or .vtt) for everyone"
            >
              CC
            </button>
            <input
              ref={captionInput}
              type="file"
              // iOS greys out extensions it has no file type for (.srt, .vtt),
              // so let anything be picked there and check the name instead.
              accept={isIOS ? undefined : ".vtt,.srt"}
              // sr-only rather than display:none: older iOS won't open a
              // picker for a hidden input via click().
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && /\.(srt|vtt)$/i.test(f.name)) p.onCaptionFile(f);
                e.target.value = "";
              }}
            />
          </>
        )}

        {/* Least-used control: leaves the bar when space is tight (it returns when there's room). */}
        {!compact && (
          <button
            type="button"
            className={btn}
            onClick={p.onPip}
            aria-label="Picture in picture"
            title="Picture in picture: keep watching in a small floating window"
          >
            PiP
          </button>
        )}
        <button
          type="button"
          className={btn}
          onClick={p.onToggleChat}
          aria-label="Toggle chat"
          title={p.unreadCount > 0 ? `Show or hide chat (C) · ${p.unreadCount} unread` : "Show or hide chat (C)"}
        >
          {"\u{1F4AC}"}
          {p.unreadCount > 0 && (
            <span className="ml-1 rounded-full bg-cinema-accent px-1.5 text-xs text-white">{p.unreadCount}</span>
          )}
        </button>
        <button
          type="button"
          className={btn}
          onClick={p.onFullscreen}
          aria-label="Toggle fullscreen"
          title="Fullscreen on/off (F, or double-click / double-tap the picture)"
        >
          {"⛶"}
        </button>
      </div>
    </div>
  );
}
