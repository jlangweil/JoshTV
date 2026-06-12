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
 * Guest-side drift correction loop (SP-05..SP-07), driven by the Fable
 * sync engine. Runs every 500ms against the authoritative playback state.
 */
export function useDriftSync(
  videoRef: RefObject<HTMLVideoElement>,
  playbackState: PlaybackState | null,
  serverNow: () => number,
  enabled: boolean
): { catchingUp: boolean } {
  const [catchingUp, setCatchingUp] = useState(false);
  const catchingUpRef = useRef(false);
  const lastCorrectionRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

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
          video.play().catch(() => {});
        } else if (driftSeconds(expected, actual) > 1.0 && canCorrect) {
          correct(expected);
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
        video.play().catch(() => {
          // Autoplay restrictions — the tap-to-unmute overlay handles this.
        });
      }
    };

    const interval = setInterval(tick, 500);
    tick();
    return () => clearInterval(interval);
  }, [videoRef, playbackState, serverNow, enabled]);

  return { catchingUp };
}
