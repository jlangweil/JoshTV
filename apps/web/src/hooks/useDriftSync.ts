import { useEffect, useRef, useState, RefObject } from "react";
import { PlaybackState } from "../types";
import {
  computeExpectedTime,
  needsCorrection,
  needsCatchUpPause,
  caughtUp,
  driftSeconds,
  bufferedAhead,
  flattenTimeRanges,
} from "../lib/sync";

/** Don't issue corrective seeks more often than this — prevents flapping. */
const CORRECTION_COOLDOWN_MS = 2500;
/** Resume from "catching up" only with this much media buffered ahead. */
const RESUME_BUFFER_S = 2;
/**
 * While catching up the video is paused and the room keeps moving, so aim a
 * little ahead: the room then arrives at the parked frame, instead of every
 * seek landing behind again.
 */
const CATCH_UP_LEAD_S = 0.4;

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
  onAutoplayBlocked?: (video: HTMLVideoElement) => void
): { catchingUp: boolean } {
  const [catchingUp, setCatchingUp] = useState(false);
  const catchingUpRef = useRef(false);
  const lastCorrectionRef = useRef(0);
  const onBlockedRef = useRef(onAutoplayBlocked);
  onBlockedRef.current = onAutoplayBlocked;

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
      }
    };

    const tick = () => {
      const video = videoRef.current;
      if (!video || !playbackState || video.readyState === 0) return;

      const expected = computeExpectedTime(
        playbackState.playing,
        playbackState.currentTime,
        playbackState.speed,
        playbackState.updatedAt,
        serverNow()
      );
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
      const ahead = bufferedAhead(flattenTimeRanges(video.buffered), actual);

      if (catchingUpRef.current) {
        // SP-07 recovery: resume only once re-buffered at the right position,
        // with enough runway that we won't immediately stall again.
        if (video.readyState >= 3 && caughtUp(expected, actual) && ahead >= RESUME_BUFFER_S) {
          setCatching(false);
          tryPlay(video);
        } else if (driftSeconds(expected, actual) > 0.5) {
          // Paused anyway, so re-seeking is harmless: do it as soon as the
          // target is buffered (e.g. the stream just delivered it, or an iPad
          // is back from the background) rather than waiting out the cooldown.
          const target = expected + CATCH_UP_LEAD_S;
          if (canCorrect || isBufferedAt(video.buffered, target)) correct(target);
        }
        return;
      }

      if (needsCatchUpPause(expected, actual)) {
        if (!canCorrect) return;
        setCatching(true);
        video.pause();
        correct(expected);
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

  return { catchingUp };
}

function isBufferedAt(ranges: TimeRanges, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t && ranges.end(i) >= t + RESUME_BUFFER_S) return true;
  }
  return false;
}
