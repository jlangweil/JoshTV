import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Controls } from "./Controls";
import { SyncIndicator } from "./SyncIndicator";
import { ReactionOverlay } from "../Reactions/ReactionOverlay";
import { Reaction } from "../../types";

interface Props {
  videoRef: RefObject<HTMLVideoElement>;
  /** Required by ManagedMediaSource (iPhone), which won't open while AirPlay is possible. */
  disableRemotePlayback?: boolean;
  containerRef: RefObject<HTMLDivElement>;
  src: string | null;
  subtitleUrl: string | null;
  muted: boolean;
  playing: boolean;
  reactions: Reaction[];
  syncPulse: number;
  isFullscreen: boolean;
  /** Rendered inside the container so it survives fullscreen (FS-02). */
  fullscreenChat: ReactNode;
  fullscreenBadge: ReactNode;
  overlay: ReactNode;
  controls: Omit<
    Parameters<typeof Controls>[0],
    "currentTime" | "duration"
  > & { duration: number };
}

export function VideoPlayer(p: Props) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringControls = useRef(false);

  // PC-09: auto-hide controls after 3s of inactivity while playing.
  const poke = () => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (p.playing && !hoveringControls.current) setControlsVisible(false);
    }, 3000);
  };

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.playing]);

  // Layout effect: must be set before the element starts loading the new src.
  useLayoutEffect(() => {
    const v = p.videoRef.current;
    if (v) v.disableRemotePlayback = Boolean(p.disableRemotePlayback);
  }, [p.videoRef, p.disableRemotePlayback, p.src]);

  // Live position readout for the seek bar.
  useEffect(() => {
    const interval = setInterval(() => {
      const v = p.videoRef.current;
      if (v) setCurrentTime(v.currentTime);
    }, 250);
    return () => clearInterval(interval);
  }, [p.videoRef]);

  return (
    <div
      ref={p.containerRef}
      className="relative flex min-h-0 grow flex-col bg-black"
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <SyncIndicator pulse={p.syncPulse} />
      <div className="relative min-h-0 grow">
        <video
          ref={p.videoRef}
          src={p.src ?? undefined}
          className="absolute inset-0 h-full w-full object-contain"
          playsInline
          preload="auto"
          muted={p.muted}
        >
          {p.subtitleUrl && (
            <track key={p.subtitleUrl} src={p.subtitleUrl} kind="subtitles" label="Subtitles" default />
          )}
        </video>
        <ReactionOverlay reactions={p.reactions} />
        {p.overlay}
        {p.isFullscreen && (
          <div className="absolute left-3 top-3 z-20 rounded-lg bg-black/50 px-2 py-1 font-mono text-xs">
            {p.fullscreenBadge}
          </div>
        )}
      </div>

      <div
        className={`z-20 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onMouseEnter={() => {
          hoveringControls.current = true;
        }}
        onMouseLeave={() => {
          hoveringControls.current = false;
          poke();
        }}
      >
        <Controls {...p.controls} currentTime={currentTime} duration={p.controls.duration} />
      </div>

      {p.isFullscreen && p.fullscreenChat}
    </div>
  );
}
