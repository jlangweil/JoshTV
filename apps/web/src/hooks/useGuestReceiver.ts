import { useEffect, useRef, useState, RefObject } from "react";
import { Socket } from "socket.io-client";
import { RTC_CONFIG, parseControl } from "../lib/streamProtocol";
import { StreamAssembler } from "../lib/StreamAssembler";

export interface ReceiverState {
  src: string | null;
  mode: "mse" | "blob" | null;
  receivedBytes: number;
  totalBytes: number;
  complete: boolean;
  error: string | null;
}

/**
 * Guest side: answers the host's WebRTC offer, feeds incoming chunks to the
 * StreamAssembler, and exposes the current media src for the video element.
 */
export function useGuestReceiver(
  socket: Socket,
  joined: boolean,
  videoRef: RefObject<HTMLVideoElement>
): ReceiverState {
  const [state, setState] = useState<ReceiverState>({
    src: null,
    mode: null,
    receivedBytes: 0,
    totalBytes: 0,
    complete: false,
    error: null,
  });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const assemblerRef = useRef<StreamAssembler | null>(null);

  useEffect(() => {
    if (!joined) return;

    const resetAssembler = () => {
      assemblerRef.current?.dispose();
      assemblerRef.current = null;
      setState({ src: null, mode: null, receivedBytes: 0, totalBytes: 0, complete: false, error: null });
    };

    const handleControl = (raw: string) => {
      const msg = parseControl(raw);
      if (!msg) return;
      if (msg.type === "meta") {
        resetAssembler();
        const video = videoRef.current;
        if (!video) return;
        const assembler = new StreamAssembler(video, {
          onSourceChanged: (src, mode) => setState((s) => ({ ...s, src, mode })),
          onProgress: (receivedBytes, totalBytes) =>
            setState((s) => ({ ...s, receivedBytes, totalBytes })),
          onComplete: () => setState((s) => ({ ...s, complete: true })),
          onError: (error) => setState((s) => ({ ...s, error })),
        });
        assembler.start(msg.size);
        assemblerRef.current = assembler;
      } else if (msg.type === "reset") {
        resetAssembler();
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
            handleControl(ev.data);
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
  }, [socket, joined, videoRef]);

  return state;
}
