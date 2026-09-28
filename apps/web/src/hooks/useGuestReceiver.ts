import { useCallback, useEffect, useRef, useState, MutableRefObject, RefObject } from "react";
import { Socket } from "socket.io-client";
import { RTC_CONFIG, parseControl, decodeChunk } from "../lib/streamProtocol";
import { StreamAssembler } from "../lib/StreamAssembler";
import { diag, mb } from "../lib/diag";
import { GuestRelayChannel, StreamChannel } from "../lib/relayChannel";

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
/** A new direct connection gets this long to connect (remote ICE can take a few seconds). */
const CONNECT_TIMEOUT_MS = 12_000;

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
  streamAvailable: boolean,
  /**
   * Relay the movie through the server instead of a direct connection. Set
   * here when direct connections fail; also sent when (re)joining the room.
   */
  relayRef: MutableRefObject<boolean>,
  /** sessionStorage key remembering relay mode for this room across reloads. */
  relayStorageKey: string
): ReceiverState & {
  loadLocalFile: (file: File) => void;
  recoverPlayback: (reason: string) => boolean;
  slowDownload: () => boolean;
} {
  const [state, setState] = useState<ReceiverState>(EMPTY);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<StreamChannel | null>(null);
  /** Direct-connection attempts that failed or stalled since the last success. */
  const p2pFailuresRef = useRef(0);
  const offerAtRef = useRef(0);
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

    /** Drop the current transport (direct connection or relay). */
    const closeTransport = () => {
      pcRef.current?.close();
      pcRef.current = null;
      dcRef.current?.close();
      dcRef.current = null;
    };

    /** Direct connections aren't working from here: route the movie through the server. */
    const switchToRelay = (reason: string) => {
      if (!relayRef.current) {
        relayRef.current = true;
        try {
          sessionStorage.setItem(relayStorageKey, "1");
        } catch {
          // not remembered across reloads
        }
        diag(`direct connection failed (${reason}): switching to relay through the server`);
      }
      pcRef.current?.close();
      pcRef.current = null;
      lastRequestRef.current = Date.now();
      lastActivityRef.current = Date.now();
      socket.emit("guest:stream-request", { relay: true });
    };

    const handleControl = (raw: string) => {
      const msg = parseControl(raw);
      if (!msg) return;
      if (msg.type === "meta") {
        if (localRef.current && localRef.current.fileId === msg.fileId) {
          // Already playing our own copy of this file — decline the stream.
          closeTransport();
          return;
        }
        const existing = assemblerRef.current;
        if (existing && mediaFileIdRef.current === msg.fileId) {
          // Reconnected stream for the same file: keep what we have.
          diag(`stream reconnected: ${existing.complete ? "already complete" : `resuming at ${mb(existing.receivedBytes)}`}`);
          if (existing.complete) closeTransport();
          else existing.resume();
          return;
        }
        dropMedia();
        mediaFileIdRef.current = msg.fileId;
        const assembler: StreamAssembler = new StreamAssembler(() => videoRef.current, {
          onSourceChanged: (src, mode) => setState((s) => ({ ...s, src, mode, managed: assembler.managed })),
          onProgress: (receivedBytes, totalBytes) => setState((s) => ({ ...s, receivedBytes, totalBytes })),
          onComplete: () => {
            setState((s) => ({ ...s, complete: true }));
            // The whole movie is here: the connection to the host is no longer
            // needed (left open, it just idles and eventually drops).
            diag("closing the stream connection (have the whole file)");
            // (The current connection — the download may have resumed on a newer one.)
            closeTransport();
          },
          onError: (error) => setState((s) => ({ ...s, error })),
          requestRange: (start, end, urgent) => {
            const dc = dcRef.current;
            if (dc?.readyState === "open") dc.send(JSON.stringify({ type: "range", start, end, urgent }));
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
      dcRef.current = null;
      lastActivityRef.current = Date.now();
      offerAtRef.current = Date.now();
      diag("stream offer received");
      pc.onconnectionstatechange = () => {
        diag(`stream connection: ${pc.connectionState}`);
        if (pc.connectionState === "connected") p2pFailuresRef.current = 0;
        // Can't be re-established directly (e.g. a strict router, a network change): relay.
        if (pc.connectionState === "failed" && pcRef.current === pc && !completeRef.current && !localRef.current) {
          switchToRelay("connection failed");
        }
      };

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
            handleControl(ev.data);
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
      const pc = pcRef.current;
      const connecting = pc !== null && (pc.connectionState === "new" || pc.connectionState === "connecting");
      // A fresh direct connection gets time to connect before we intervene.
      if (connecting && now - offerAtRef.current < CONNECT_TIMEOUT_MS) return;
      const open = dcRef.current?.readyState === "open" && pc?.connectionState !== "failed";
      const idleFor = now - lastActivityRef.current;
      if (open ? idleFor < STALL_MS : idleFor < 3000) return;
      if (now - lastRequestRef.current < REQUEST_COOLDOWN_MS) return;
      const reason = open ? `no data for ${Math.round(idleFor / 1000)}s` : connecting ? "never connected" : "connection closed";
      // Direct connection never came up, or keeps dying: stop trying it.
      if (!relayRef.current && (connecting || ++p2pFailuresRef.current >= 2)) {
        switchToRelay(reason);
        return;
      }
      lastRequestRef.current = now;
      lastActivityRef.current = now;
      diag(`stream stalled (${reason}): asking host for a new one${relayRef.current ? " (relay)" : ""}`);
      socket.emit("guest:stream-request", { relay: relayRef.current });
    };

    // Relayed stream (server fallback): same protocol as the data channel.
    const onRelayData = (d: { data: unknown }) => {
      lastActivityRef.current = Date.now();
      if (!(dcRef.current instanceof GuestRelayChannel)) {
        pcRef.current?.close();
        pcRef.current = null;
        dcRef.current = new GuestRelayChannel(socket);
      }
      const relay = dcRef.current as GuestRelayChannel;
      if (typeof d.data === "string") {
        handleControl(d.data);
      } else if (d.data instanceof ArrayBuffer) {
        relay.countReceived(d.data.byteLength);
        const { offset, data } = decodeChunk(d.data);
        assemblerRef.current?.push(offset, data);
      }
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
    socket.on("relay:data", onRelayData);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      socket.off("rtc:offer", onOffer);
      socket.off("rtc:ice", onIce);
      socket.off("relay:data", onRelayData);
      closeTransport();
      assemblerRef.current?.dispose();
      assemblerRef.current = null;
    };
  }, [socket, joined, videoRef, dropMedia, relayRef, relayStorageKey]);

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

  const recoverPlayback = useCallback((reason: string) => assemblerRef.current?.recover(reason) ?? false, []);
  /** Catching up is slow because the download is, not because playback is broken. */
  const slowDownload = useCallback(() => assemblerRef.current?.fetchingJump ?? false, []);

  return { ...state, loadLocalFile, recoverPlayback, slowDownload };
}
