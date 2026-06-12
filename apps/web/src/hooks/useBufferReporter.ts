import { useEffect, RefObject } from "react";
import { Socket } from "socket.io-client";
import { bufferedAhead, flattenTimeRanges } from "../lib/sync";

/**
 * Guest-side buffer telemetry (BF-02): every 500ms report buffered-ahead
 * seconds, readiness, and transfer progress to the server.
 */
export function useBufferReporter(
  socket: Socket,
  videoRef: RefObject<HTMLVideoElement>,
  enabled: boolean,
  receivedBytes: number,
  complete: boolean
): void {
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const ahead = complete
        ? Number.POSITIVE_INFINITY
        : bufferedAhead(flattenTimeRanges(video.buffered), video.currentTime);
      socket.emit("guest:buffer", {
        aheadSeconds: Number.isFinite(ahead) ? ahead : 99999,
        ready: video.readyState >= 3,
        receivedBytes,
        complete,
      });
    }, 500);
    return () => clearInterval(interval);
  }, [socket, videoRef, enabled, receivedBytes, complete]);
}
