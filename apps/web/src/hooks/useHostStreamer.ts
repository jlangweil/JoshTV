import { useCallback, useEffect, useRef, useState } from "react";
import { Socket } from "socket.io-client";
import {
  FILE_READ_CHUNK,
  WIRE_CHUNK,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
  RTC_CONFIG,
  encodeChunk,
  parseControl,
} from "../lib/streamProtocol";

interface ByteRange {
  start: number;
  end: number;
}

interface PeerStream {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  generation: number;
  /** Range being sent; a guest "range" request replaces it mid-flight. */
  job: ByteRange | null;
  /** Resolves the send loop's idle wait when a new job arrives. */
  wake: (() => void) | null;
}

/**
 * Host side of the media pipeline: one RTCPeerConnection + DataChannel per
 * guest. Each guest gets byte 0 onward by default and can redirect the
 * stream to any range (late join / far seek); chunks go out with
 * backpressure (BF-08). Replacing the file bumps the generation counter,
 * which aborts in-flight send loops and restarts every stream.
 */
export function useHostStreamer(socket: Socket, joined: boolean) {
  const fileRef = useRef<File | null>(null);
  const fileIdRef = useRef<string>("");
  const peersRef = useRef<Map<string, PeerStream>>(new Map());
  const generationRef = useRef(0);
  const [activeStreams, setActiveStreams] = useState(0);

  const teardownPeer = useCallback((guestId: string) => {
    const peer = peersRef.current.get(guestId);
    if (peer) {
      try {
        peer.dc.close();
        peer.pc.close();
      } catch {
        // already closed
      }
      peersRef.current.delete(guestId);
      setActiveStreams(peersRef.current.size);
    }
  }, []);

  const streamFile = useCallback(async (guestId: string, peer: PeerStream) => {
    const file = fileRef.current;
    const fileId = fileIdRef.current;
    if (!file) return;
    const myGeneration = peer.generation;
    const dc = peer.dc;
    dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

    const alive = () =>
      peersRef.current.get(guestId) === peer &&
      peer.generation === myGeneration &&
      generationRef.current === myGeneration &&
      dc.readyState === "open";

    const waitDrain = () =>
      new Promise<void>((resolve) => {
        if (dc.bufferedAmount <= HIGH_WATER_MARK) return resolve();
        const handler = () => {
          dc.removeEventListener("bufferedamountlow", handler);
          resolve();
        };
        dc.addEventListener("bufferedamountlow", handler);
        // Safety: re-check every second in case the event is missed.
        const poll = setInterval(() => {
          if (dc.readyState !== "open" || dc.bufferedAmount <= LOW_WATER_MARK) {
            clearInterval(poll);
            dc.removeEventListener("bufferedamountlow", handler);
            resolve();
          }
        }, 1000);
      });

    dc.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseControl(ev.data);
      if (msg?.type !== "range") return;
      const start = Math.max(0, Math.floor(Number(msg.start) || 0));
      const end = Math.min(file.size, Math.floor(Number(msg.end) || 0));
      if (end <= start) return;
      peer.job = { start, end };
      peer.wake?.();
    };
    dc.addEventListener("close", () => peer.wake?.());

    try {
      dc.send(JSON.stringify({ type: "meta", fileId, name: file.name, size: file.size }));
      peer.job = { start: 0, end: file.size };
      while (alive()) {
        const job: ByteRange | null = peer.job;
        if (!job) {
          // Guest has everything it asked for; sleep until the next request.
          await new Promise<void>((resolve) => (peer.wake = resolve));
          peer.wake = null;
          continue;
        }
        const current = () => alive() && peer.job === job;
        let offset = job.start;
        while (offset < job.end && current()) {
          const slice = await file.slice(offset, Math.min(offset + FILE_READ_CHUNK, job.end)).arrayBuffer();
          for (let i = 0; i < slice.byteLength && current(); i += WIRE_CHUNK) {
            if (dc.bufferedAmount > HIGH_WATER_MARK) await waitDrain();
            if (!current()) break;
            dc.send(encodeChunk(offset + i, slice.slice(i, i + WIRE_CHUNK)));
          }
          offset += slice.byteLength;
        }
        if (peer.job === job) peer.job = null;
      }
    } catch (e) {
      console.warn(`stream to ${guestId} aborted:`, e);
    }
  }, []);

  const openStreamTo = useCallback(
    async (guestId: string) => {
      if (!fileRef.current) return;
      teardownPeer(guestId);

      const pc = new RTCPeerConnection(RTC_CONFIG);
      const dc = pc.createDataChannel("media", { ordered: true });
      dc.binaryType = "arraybuffer";
      const peer: PeerStream = { pc, dc, generation: generationRef.current, job: null, wake: null };
      peersRef.current.set(guestId, peer);
      setActiveStreams(peersRef.current.size);

      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit("rtc:ice", { targetSocketId: guestId, candidate: e.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
          // The guest re-requests a stream after its own reconnect logic.
          if (peersRef.current.get(guestId) === peer) teardownPeer(guestId);
        }
      };
      dc.onopen = () => streamFile(guestId, peer);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("rtc:offer", { targetSocketId: guestId, sdp: offer });
    },
    [socket, streamFile, teardownPeer]
  );

  // Signaling: answers/ICE back from guests, and stream requests from server.
  useEffect(() => {
    if (!joined) return;

    const onAnswer = async (d: { fromSocketId: string; sdp: RTCSessionDescriptionInit }) => {
      const peer = peersRef.current.get(d.fromSocketId);
      if (peer) {
        try {
          await peer.pc.setRemoteDescription(d.sdp);
        } catch (e) {
          console.warn("setRemoteDescription failed", e);
        }
      }
    };
    const onIce = async (d: { fromSocketId: string; candidate: RTCIceCandidateInit }) => {
      const peer = peersRef.current.get(d.fromSocketId);
      if (peer && d.candidate) {
        try {
          await peer.pc.addIceCandidate(d.candidate);
        } catch {
          // harmless when the peer was torn down mid-negotiation
        }
      }
    };
    const onStreamRequest = (d: { guestSocketId: string }) => {
      openStreamTo(d.guestSocketId);
    };
    const onLeave = (d: { user: { id: string } }) => teardownPeer(d.user.id);

    socket.on("rtc:answer", onAnswer);
    socket.on("rtc:ice", onIce);
    socket.on("stream:request", onStreamRequest);
    socket.on("room:leave", onLeave);
    return () => {
      socket.off("rtc:answer", onAnswer);
      socket.off("rtc:ice", onIce);
      socket.off("stream:request", onStreamRequest);
      socket.off("room:leave", onLeave);
    };
  }, [socket, joined, openStreamTo, teardownPeer]);

  // Tear everything down on unmount.
  useEffect(() => {
    const peers = peersRef.current;
    return () => {
      for (const id of [...peers.keys()]) {
        const p = peers.get(id);
        try {
          p?.dc.close();
          p?.pc.close();
        } catch {
          // ignore
        }
      }
      peers.clear();
    };
  }, []);

  /**
   * Host picked (or replaced) a file: restart streams to guestIds (FL-04).
   * Pass no guests when viewers use their own copies; the server can still
   * request individual streams later via stream:request.
   */
  const setFile = useCallback(
    (file: File, fileId: string, guestIds: string[]) => {
      fileRef.current = file;
      fileIdRef.current = fileId;
      generationRef.current += 1;
      for (const id of guestIds) openStreamTo(id);
    },
    [openStreamTo]
  );

  /** Streaming switched off: close every guest connection. */
  const stopAll = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) teardownPeer(id);
  }, [teardownPeer]);

  return { setFile, stopAll, activeStreams };
}
