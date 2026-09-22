import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import { Socket } from "socket.io-client";
import { RTC_CONFIG, parseControl } from "../lib/streamProtocol";
import { StreamAssembler } from "../lib/StreamAssembler";

export interface ReceiverState {
  src: string | null;
  /** "local" = the guest picked their own copy of the file; nothing is streamed. */
  mode: "mse" | "blob" | "local" | null;
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
  fileId: null,
  receivedBytes: 0,
  totalBytes: 0,
  complete: false,
  error: null,
};

/**
 * Guest side: answers the host's WebRTC offer, feeds incoming chunks to the
 * StreamAssembler, and exposes the current media src for the video element.
 * Alternatively the guest can play their own local copy (loadLocalFile), which
 * drops the stream entirely.
 */
export function useGuestReceiver(
  socket: Socket,
  joined: boolean,
  videoRef: RefObject<HTMLVideoElement>,
  /** Room's current FileMeta.id; media for any other id is stale. */
  currentFileId: string | null
): ReceiverState & { loadLocalFile: (file: File) => void } {
  const [state, setState] = useState<ReceiverState>(EMPTY);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const assemblerRef = useRef<StreamAssembler | null>(null);
  const localRef = useRef<{ fileId: string | null; url: string } | null>(null);
  const mediaFileIdRef = useRef<string | null>(null);
  const currentFileIdRef = useRef(currentFileId);
  currentFileIdRef.current = currentFileId;

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
    if (currentFileId && mediaFileIdRef.current && mediaFileIdRef.current !== currentFileId) {
      dropMedia();
    }
  }, [currentFileId, dropMedia]);

  useEffect(() => {
    if (!joined) return;

    const handleControl = (raw: string, pc: RTCPeerConnection) => {
      const msg = parseControl(raw);
      if (!msg) return;
      if (msg.type === "meta") {
        if (localRef.current && localRef.current.fileId === msg.fileId) {
          // Already playing our own copy of this file — decline the stream.
          pc.close();
          return;
        }
        dropMedia();
        mediaFileIdRef.current = msg.fileId;
        const assembler = new StreamAssembler(() => videoRef.current, {
          onSourceChanged: (src, mode) => setState((s) => ({ ...s, src, mode })),
          onProgress: (receivedBytes, totalBytes) =>
            setState((s) => ({ ...s, receivedBytes, totalBytes })),
          onComplete: () => setState((s) => ({ ...s, complete: true })),
          onError: (error) => setState((s) => ({ ...s, error })),
        });
        setState((s) => ({ ...s, fileId: msg.fileId }));
        assembler.start(msg.size);
        assemblerRef.current = assembler;
      } else if (msg.type === "reset") {
        dropMedia();
      } else if (msg.type === "eof") {
        assemblerRef.current?.eof();
      }
    };

    const onOffer = async (d: { fromSocketId: string; sdp: RTCSessionDescriptionInit }) => {
      // The host replaces any previous connection with a fresh offer.
      pcRef.current?.close();
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit("rtc:ice", { targetSocketId: d.fromSocketId, candidate: e.candidate });
      };
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = "arraybuffer";
        dc.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            handleControl(ev.data, pc);
          } else if (ev.data instanceof ArrayBuffer) {
            assemblerRef.current?.push(ev.data);
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

    socket.on("rtc:offer", onOffer);
    socket.on("rtc:ice", onIce);
    return () => {
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
      setState({
        src: url,
        mode: "local",
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
