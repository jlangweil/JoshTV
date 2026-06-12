/** Thin accent line that flashes across the top of the video on sync events. */
export function SyncIndicator({ pulse }: { pulse: number }) {
  if (pulse === 0) return null;
  return (
    <div
      key={pulse}
      className="sync-pulse absolute left-0 top-0 z-20 h-0.5 w-full bg-cinema-accent"
      aria-hidden="true"
    />
  );
}
