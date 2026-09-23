// Typed facade over the Fable-compiled F# sync engine (apps/web/src/fable-gen).
// Run `npm run fable` from the repo root to regenerate.
import * as Api from "../fable-gen/Api.js";

/** samples: flat [clientSend, serverTime, clientReceive, ...] epoch-ms triples. */
export const computeClockOffset: (samples: number[]) => number = Api.computeClockOffset;

export const computeExpectedTime: (
  playing: boolean,
  currentTime: number,
  speed: number,
  updatedAt: number,
  serverNow: number
) => number = Api.computeExpectedTime;

export const driftSeconds: (expected: number, actual: number) => number = Api.driftSeconds;
export const needsCorrection: (expected: number, actual: number) => boolean = Api.needsCorrection;
export const needsCatchUpPause: (expected: number, actual: number) => boolean = Api.needsCatchUpPause;
export const caughtUp: (expected: number, actual: number) => boolean = Api.caughtUp;

/** ranges: flat [start, end, start, end, ...] from video.buffered. */
export const bufferedAhead: (ranges: number[], currentTime: number) => number = Api.bufferedAhead;
export const bufferHealth: (aheadSeconds: number, isComplete: boolean) => "green" | "yellow" | "red" =
  Api.bufferHealth;

export function flattenTimeRanges(ranges: TimeRanges): number[] {
  const out: number[] = [];
  for (let i = 0; i < ranges.length; i++) {
    out.push(ranges.start(i), ranges.end(i));
  }
  return out;
}
