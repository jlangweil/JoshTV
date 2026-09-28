import { useEffect, useRef, useState, RefObject } from "react";
import { PlaybackState } from "../types";
import {
  computeExpectedTime,
  needsCorrection,
  needsCatchUpPause,
  driftSeconds,
} from "../lib/sync";

/** Don't issue corrective seeks more often than this — prevents flapping. */
const CORRECTION_COOLDOWN_MS = 2500;
/** "Buffered at the target" means at least this much media from there on. */
const RESUME_BUFFER_S = 2;
/**
 * While catching up, the room keeps moving as the video waits for data, so
 * aim a little ahead: the room then arrives at that spot, instead of every
 * seek landing behind again.
 */
const CATCH_UP_LEAD_S = 0.4;
/** Catching up this long means something is wrong: report it and try to recover. */
const STUCK_RECOVER_MS = 12_000;
/** Still stuck after this: offer the viewer a reload. */
const STUCK_GIVE_UP_MS = 30_000;

/**
 * Guest-side drift correction loop (SP-05..SP-07), driven by the Fable
 * sync engine. Runs every 500ms against the authoritative playback state.
 */
export function useDriftSync(
  videoRef: RefObject<HTMLVideoElement>,
  playbackState: PlaybackState | null,
  serverNow: () => number,
  enabled: boolean,
  /** Browser refused playback (no user interaction yet, or iOS Low Power Mode). */
  onAutoplayBlocked?: (video: HTMLVideoElement) => void,
  /** Catching up has taken far too long: diagnose and try to recover the player. */
  onStuck?: (video: HTMLVideoElement, expected: number) => void
): { catchingUp: boolean; stuck: boolean } {
  const [catchingUp, setCatchingUp] = useState(false);
  const [stuck, setStuck] = useState(false);
  const catchingUpRef = useRef(false);
  const catchSinceRef = useRef(0);
  const recoveredRef = useRef(false);
  const lastCorrectionRef = useRef(0);
  const onBlockedRef = useRef(onAutoplayBlocked);
  onBlockedRef.current = onAutoplayBlocked;
  const onStuckRef = useRef(onStuck);
  onStuckRef.current = onStuck;

  useEffect(() => {
    if (!enabled) return;

    const tryPlay = (video: HTMLVideoElement) => {
      video.play().catch((e) => {
        if ((e as DOMException)?.name === "NotAllowedError") onBlockedRef.current?.(video);
      });
    };

    const setCatching = (value: boolean) => {
      if (catchingUpRef.current !== value) {
        catchingUpRef.current = value;
        setCatchingUp(value);
        catchSinceRef.current = Date.now();
        recoveredRef.current = false;
        if (!value) setStuck(false);
      }
    };

    const tick = () => {
      const video = videoRef.current;
      if (!video || !playbackState) return;

      const expected = computeExpectedTime(
        playbackState.playing,
        playbackState.currentTime,
        playbackState.speed,
        playbackState.updatedAt,
        serverNow()
      );

      // Stuck watchdog — runs even when the element has no data at all
      // (readyState 0), which is exactly when it matters.
      if (catchingUpRef.current) {
        const waited = Date.now() - catchSinceRef.current;
        if (!recoveredRef.current && waited > STUCK_RECOVER_MS) {
          recoveredRef.current = true;
          onStuckRef.current?.(video, expected);
        }
        if (waited > STUCK_GIVE_UP_MS) setStuck(true);
      }
      if (video.readyState === 0) return;
      const actual = video.currentTime;
      const now = Date.now();
      const canCorrect = now - lastCorrectionRef.current > CORRECTION_COOLDOWN_MS;
      const correct = (t: number) => {
        video.currentTime = t;
        lastCorrectionRef.current = now;
      };

      if (video.playbackRate !== playbackState.speed) {
        video.playbackRate = playbackState.speed;
      }

      if (!playbackState.playing) {
        if (!video.paused) video.pause();
        if (driftSeconds(expected, actual) > 0.5 && canCorrect) {
          correct(expected);
        }
        setCatching(false);
        return;
      }

      // Playing.

      if (catchingUpRef.current) {
        // SP-07: the element is kept *playing* while it lands — iOS doesn't
        // buffer a paused video, so waiting paused for data could wait forever.
        // Done once it is actually playing, with data, at the right spot.
        if (!video.paused && video.readyState >= 3 && driftSeconds(expected, actual) < 1) {
          setCatching(false);
          return;
        }
        if (driftSeconds(expected, actual) > 1) {
          // The room moved on while we waited: aim again, as soon as the
          // target is buffered rather than waiting out the cooldown.
          const target = expected + CATCH_UP_LEAD_S;
          if (canCorrect || isBufferedAt(video.buffered, target)) correct(target);
        }
        if (video.paused) tryPlay(video);
        return;
      }

      if (needsCatchUpPause(expected, actual)) {
        if (!canCorrect) return;
        setCatching(true);
        correct(expected + CATCH_UP_LEAD_S);
        if (video.paused) tryPlay(video);
      } else if (needsCorrection(expected, actual)) {
        // SP-06: silent re-seek.
        if (canCorrect) correct(expected);
      } else if (video.paused) {
        tryPlay(video);
      }
    };

    const interval = setInterval(tick, 500);
    tick();
    return () => clearInterval(interval);
  }, [videoRef, playbackState, serverNow, enabled]);

  return { catchingUp, stuck };
}

function isBufferedAt(ranges: TimeRanges, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t && ranges.end(i) >= t + RESUME_BUFFER_S) return true;
  }
  return false;
}
