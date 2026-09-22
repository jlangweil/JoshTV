import { useEffect, RefObject } from "react";
import { Socket } from "socket.io-client";
import { bufferedAhead, flattenTimeRanges } from "../lib/sync";

/**
 * Guest-side buffer telemetry (BF-02): every 500ms report buffered-ahead
 * seconds, readiness, and transfer progress to the server. fileId ties the
 * report to one loaded video so reports for a replaced file are discarded.
 */
export function useBufferReporter(
  socket: Socket,
  videoRef: RefObject<HTMLVideoElement>,
  enabled: boolean,
  fileId: string | null,
  receivedBytes: number,
  complete: boolean,
  local: boolean
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
        fileId,
        aheadSeconds: Number.isFinite(ahead) ? ahead : 99999,
        ready: video.readyState >= 3,
        receivedBytes,
        complete,
        local,
      });
    }, 500);
    return () => clearInterval(interval);
  }, [socket, videoRef, enabled, fileId, receivedBytes, complete, local]);
}
