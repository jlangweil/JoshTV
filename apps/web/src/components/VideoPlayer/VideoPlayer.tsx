import { MutableRefObject, ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Controls } from "./Controls";
import { SyncIndicator } from "./SyncIndicator";
import { ReactionOverlay } from "../Reactions/ReactionOverlay";
import { Reaction } from "../../types";
import { getPlayerElement } from "../../lib/sharedVideo";

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

/** Two taps this close together (ms) on the picture toggle fullscreen. */
const DOUBLE_TAP_MS = 300;

export function VideoPlayer(p: Props) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoveringControls = useRef(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const lastTapRef = useRef(0);

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

  // The <video> is the app-wide shared element (see lib/sharedVideo.ts), so a
  // tap before this player existed can already have unlocked sound on it.
  useLayoutEffect(() => {
    const v = getPlayerElement();
    v.className = "absolute inset-0 h-full w-full object-contain";
    slotRef.current?.appendChild(v);
    (p.videoRef as MutableRefObject<HTMLVideoElement | null>).current = v;
    return () => {
      (p.videoRef as MutableRefObject<HTMLVideoElement | null>).current = null;
      v.pause();
      v.removeAttribute("src");
      v.load(); // release the movie
      v.remove();
    };
  }, [p.videoRef]);

  // Layout effects: attributes must be in place before the element starts
  // loading a new src (ManagedMediaSource checks disableRemotePlayback then).
  useLayoutEffect(() => {
    const v = getPlayerElement();
    v.disableRemotePlayback = Boolean(p.disableRemotePlayback);
    if (p.src) {
      if (v.getAttribute("src") !== p.src) v.src = p.src;
    } else if (v.hasAttribute("src")) {
      v.removeAttribute("src");
      v.load();
    }
  }, [p.src, p.disableRemotePlayback]);

  useLayoutEffect(() => {
    getPlayerElement().muted = p.muted;
  }, [p.muted]);

  useEffect(() => {
    const v = getPlayerElement();
    for (const t of [...v.querySelectorAll("track")]) t.remove();
    if (!p.subtitleUrl) return;
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Subtitles";
    track.src = p.subtitleUrl;
    track.default = true;
    v.appendChild(track);
    return () => track.remove();
  }, [p.subtitleUrl]);

  // Live position readout for the seek bar.
  useEffect(() => {
    const interval = setInterval(() => {
      const v = p.videoRef.current;
      if (v) setCurrentTime(v.currentTime);
    }, 250);
    return () => clearInterval(interval);
  }, [p.videoRef]);

  // Double tap on the picture toggles fullscreen — on iPad that's the natural
  // way out. (Pages use touch-action: manipulation, so the browser doesn't
  // turn the double tap into a zoom.) Taps on buttons don't count.
  const onControl = (e: React.SyntheticEvent) => Boolean((e.target as Element).closest("button, a, input, label, select"));
  const onPictureTouchEnd = (e: React.TouchEvent) => {
    if (onControl(e)) return;
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      e.preventDefault();
      p.controls.onFullscreen();
    } else {
      lastTapRef.current = now;
    }
  };

  return (
    <div
      ref={p.containerRef}
      // In fullscreen the chat sits beside the player (below it in portrait)
      // instead of on top, so it never covers the picture or controls.
      className="relative flex min-h-0 min-w-0 grow flex-col bg-black landscape:flex-row lg:flex-row"
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <div className="relative flex min-h-0 min-w-0 grow flex-col">
        <SyncIndicator pulse={p.syncPulse} />
        <div className="relative min-h-0 grow" onTouchEnd={onPictureTouchEnd} onDoubleClick={(e) => !onControl(e) && p.controls.onFullscreen()}>
          <div ref={slotRef} className="absolute inset-0" />
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
      </div>

      {p.isFullscreen && p.fullscreenChat}
    </div>
  );
}
