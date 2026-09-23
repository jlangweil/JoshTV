import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import { Socket } from "socket.io-client";
import { RTC_CONFIG, parseControl, decodeChunk } from "../lib/streamProtocol";
import { StreamAssembler } from "../lib/StreamAssembler";
import { diag, mb } from "../lib/diag";

export interface ReceiverState {
  src: string | null;
  /** "local" = the guest picked their own copy of the file; nothing is streamed. */
  mode: "mse" | "blob" | "local" | null;
  /** ManagedMediaSource in use (iPhone): the <video> needs disableRemotePlayback. */
  managed: boolean;
  /** Not keeping the whole movie (no disk storage on iOS): no download progress to show. */
  streamingOnly: boolean;
  /** FileMeta.id the current media belongs to. */
  fileId: string | null;
  receivedBytes: number;
  totalBytes: number;
  complete: boolean;
  error: string | null;
}

const EMPTY: ReceiverState = {
  src: null,
  mode: null,
  managed: false,
  streamingOnly: false,
  fileId: null,
  receivedBytes: 0,
  totalBytes: 0,
  complete: false,
  error: null,
};

/** No bytes for this long while incomplete = the connection died (iOS suspends backgrounded pages). */
const STALL_MS = 6000;
/** Don't ask the host for a fresh stream more often than this. */
const REQUEST_COOLDOWN_MS = 8000;

/**
 * Guest side: answers the host's WebRTC offer, feeds incoming chunks to the
 * StreamAssembler, and exposes the current media src for the video element.
 * Alternatively the guest can play their own local copy (loadLocalFile), which
 * drops the stream entirely.
 *
 * A watchdog notices when the stream stops delivering (the iPad left Safari,
 * the screen locked, Wi-Fi dropped) and asks the host for a new connection;
 * a new stream for the same file resumes where the download left off.
 */
export function useGuestReceiver(
  socket: Socket,
  joined: boolean,
  videoRef: RefObject<HTMLVideoElement>,
  /** Room's current FileMeta.id; media for any other id is stale. */
  currentFileId: string | null,
  /** Where the room is right now (seconds), so a late joiner fetches that part first. */
  getRoomTime: () => number | null,
  /** The host is connected and streaming to viewers. */
  streamAvailable: boolean
): ReceiverState & { loadLocalFile: (file: File) => void } {
  const [state, setState] = useState<ReceiverState>(EMPTY);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const assemblerRef = useRef<StreamAssembler | null>(null);
  const localRef = useRef<{ fileId: string | null; url: string } | null>(null);
  const mediaFileIdRef = useRef<string | null>(null);
  const currentFileIdRef = useRef(currentFileId);
  currentFileIdRef.current = currentFileId;
  const getRoomTimeRef = useRef(getRoomTime);
  getRoomTimeRef.current = getRoomTime;
  const streamAvailableRef = useRef(streamAvailable);
  streamAvailableRef.current = streamAvailable;
  const completeRef = useRef(state.complete);
  completeRef.current = state.complete;
  const lastActivityRef = useRef(Date.now());
  const lastRequestRef = useRef(0);

  const dropMedia = useCallback(() => {
    assemblerRef.current?.dispose();
    assemblerRef.current = null;
    if (localRef.current) URL.revokeObjectURL(localRef.current.url);
    localRef.current = null;
    mediaFileIdRef.current = null;
    setState(EMPTY);
  }, []);

  // Host replaced the video: whatever we hold (download or local copy) is the
  // wrong movie now. A stream for the new id that raced ahead of this socket
  // event already set mediaFileIdRef to the new id, so it survives.
  useEffect(() => {
    lastActivityRef.current = Date.now();
    if (currentFileId && mediaFileIdRef.current && mediaFileIdRef.current !== currentFileId) {
      dropMedia();
    }
  }, [currentFileId, dropMedia]);

  useEffect(() => {
    if (!joined) return;
    lastActivityRef.current = Date.now();

    const handleControl = (raw: string, pc: RTCPeerConnection) => {
      const msg = parseControl(raw);
      if (!msg) return;
      if (msg.type === "meta") {
        if (localRef.current && localRef.current.fileId === msg.fileId) {
          // Already playing our own copy of this file — decline the stream.
          pc.close();
          return;
        }
        const existing = assemblerRef.current;
        if (existing && mediaFileIdRef.current === msg.fileId) {
          // Reconnected stream for the same file: keep what we have.
          diag(`stream reconnected: ${existing.complete ? "already complete" : `resuming at ${mb(existing.receivedBytes)}`}`);
          if (existing.complete) pc.close();
          else existing.resume();
          return;
        }
        dropMedia();
        mediaFileIdRef.current = msg.fileId;
        const assembler: StreamAssembler = new StreamAssembler(() => videoRef.current, {
          onSourceChanged: (src, mode) => setState((s) => ({ ...s, src, mode, managed: assembler.managed })),
          onProgress: (receivedBytes, totalBytes) => setState((s) => ({ ...s, receivedBytes, totalBytes })),
          onComplete: () => setState((s) => ({ ...s, complete: true })),
          onError: (error) => setState((s) => ({ ...s, error })),
          requestRange: (start, end) => {
            const dc = dcRef.current;
            if (dc?.readyState === "open") dc.send(JSON.stringify({ type: "range", start, end }));
          },
          log: diag,
        });
        assemblerRef.current = assembler;
        assembler.start(msg.size, msg.fileId);
        setState((s) => ({ ...s, fileId: msg.fileId, streamingOnly: assembler.storageKind === "window" }));
      } else if (msg.type === "reset") {
        dropMedia();
      }
    };

    const onOffer = async (d: { fromSocketId: string; sdp: RTCSessionDescriptionInit }) => {
      // The host replaces any previous connection with a fresh offer.
      pcRef.current?.close();
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      lastActivityRef.current = Date.now();
      diag("stream offer received");
      pc.onconnectionstatechange = () => diag(`stream connection: ${pc.connectionState}`);

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit("rtc:ice", { targetSocketId: d.fromSocketId, candidate: e.candidate });
      };
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = "arraybuffer";
        dcRef.current = dc;
        dc.onmessage = (ev) => {
          lastActivityRef.current = Date.now();
          if (typeof ev.data === "string") {
            handleControl(ev.data, pc);
          } else if (ev.data instanceof ArrayBuffer) {
            const { offset, data } = decodeChunk(ev.data);
            assemblerRef.current?.push(offset, data);
          }
        };
      };

      try {
        await pc.setRemoteDescription(d.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("rtc:answer", { targetSocketId: d.fromSocketId, sdp: answer });
      } catch (e) {
        setState((s) => ({ ...s, error: `WebRTC negotiation failed: ${String(e)}` }));
      }
    };

    const onIce = async (d: { candidate: RTCIceCandidateInit }) => {
      if (pcRef.current && d.candidate) {
        try {
          await pcRef.current.addIceCandidate(d.candidate);
        } catch {
          // stale candidate after reconnect — safe to ignore
        }
      }
    };

    // Stream watchdog: if nothing has arrived for a while and we still need
    // data, the connection is gone — ask the host (via the server) for a new one.
    const checkStream = () => {
      if (!streamAvailableRef.current || !currentFileIdRef.current) return;
      if (localRef.current || completeRef.current) return;
      // Streaming-only guests go quiet on purpose once they're far enough ahead.
      if (assemblerRef.current && !assemblerRef.current.expectingData) {
        lastActivityRef.current = Date.now();
        return;
      }
      const now = Date.now();
      const open = dcRef.current?.readyState === "open" && pcRef.current?.connectionState !== "failed";
      const idleFor = now - lastActivityRef.current;
      if (open ? idleFor < STALL_MS : idleFor < 3000) return;
      if (now - lastRequestRef.current < REQUEST_COOLDOWN_MS) return;
      lastRequestRef.current = now;
      lastActivityRef.current = now;
      diag(`stream stalled (${open ? `no data for ${Math.round(idleFor / 1000)}s` : "connection closed"}): asking host for a new one`);
      socket.emit("guest:stream-request");
    };

    const timer = setInterval(() => {
      // Late join / host jumped ahead: steer the download to the room's position.
      assemblerRef.current?.tick(getRoomTimeRef.current());
      checkStream();
    }, 500);
    const onVisible = () => {
      if (document.visibilityState === "visible") checkStream();
    };
    document.addEventListener("visibilitychange", onVisible);

    socket.on("rtc:offer", onOffer);
    socket.on("rtc:ice", onIce);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      socket.off("rtc:offer", onOffer);
      socket.off("rtc:ice", onIce);
      pcRef.current?.close();
      pcRef.current = null;
      assemblerRef.current?.dispose();
      assemblerRef.current = null;
    };
  }, [socket, joined, videoRef, dropMedia]);

  useEffect(() => {
    return () => {
      if (localRef.current) URL.revokeObjectURL(localRef.current.url);
    };
  }, []);

  /** Play the guest's own copy of the movie instead of the host's stream. */
  const loadLocalFile = useCallback(
    (file: File) => {
      // Closing our end stops the host's send loop for this guest.
      pcRef.current?.close();
      pcRef.current = null;
      dropMedia();
      const url = URL.createObjectURL(file);
      const fileId = currentFileIdRef.current;
      localRef.current = { fileId, url };
      mediaFileIdRef.current = fileId;
      diag(`using own copy: ${file.name} (${mb(file.size)})`);
      setState({
        src: url,
        mode: "local",
        managed: false,
        streamingOnly: false,
        fileId,
        receivedBytes: file.size,
        totalBytes: file.size,
        complete: true,
        error: null,
      });
    },
    [dropMedia]
  );

  return { ...state, loadLocalFile };
}
