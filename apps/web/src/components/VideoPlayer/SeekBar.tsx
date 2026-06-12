export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface Props {
  currentTime: number;
  duration: number;
  /** Undefined for guests (SP-08: read-only seek bar). */
  onSeek?: (t: number) => void;
}

export function SeekBar({ currentTime, duration, onSeek }: Props) {
  const max = Math.max(duration, 0.01);
  return (
    <div className="flex w-full items-center gap-3">
      <div className="filmstrip-track relative h-1 grow rounded">
        <input
          type="range"
          className="seek-range absolute inset-x-0 -top-1.5 w-full"
          min={0}
          max={max}
          step={0.1}
          value={Math.min(currentTime, max)}
          disabled={!onSeek}
          aria-label={onSeek ? "Seek" : "Playback position (host controls seeking)"}
          onChange={(e) => onSeek?.(Number(e.target.value))}
        />
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded bg-cinema-accent"
          style={{ width: `${(Math.min(currentTime, max) / max) * 100}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-xs text-cinema-text/80">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
    </div>
  );
}
