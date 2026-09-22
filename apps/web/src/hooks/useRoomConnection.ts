import { useEffect, useMemo, useRef, useState, useCallback, MutableRefObject } from "react";
import { io, Socket } from "socket.io-client";
import {
  PlaybackState,
  ChatMessage,
  RoomUser,
  FileMeta,
  GuestBufferState,
  Reaction,
} from "../types";
import { Identity } from "../lib/identity";
import { computeClockOffset } from "../lib/sync";

export interface RoomConnection {
  socket: Socket;
  connected: boolean;
  joined: boolean;
  /** Increments on every successful join, including reconnects. */
  joinCount: number;
  joinError: string | null;
  users: RoomUser[];
  chat: ChatMessage[];
  playbackState: PlaybackState | null;
  /** serverNow() — local clock corrected by the NTP-style offset. */
  serverNow: () => number;
  clockOffset: number;
  fileMeta: FileMeta | null;
  bufferStates: Record<string, GuestBufferState>;
  reactions: Reaction[];
  pauseRequest: { user: string; id: string } | null;
  hostConnected: boolean;
  hostGoneForever: boolean;
  autoPauseOnBufferLow: boolean;
  /** False when the host wants every viewer to load their own copy. */
  streamToGuests: boolean;
  subtitleVtt: string | null;
  syncPulse: number;
  sendChat: (text: string) => void;
  sendReaction: (emoji: string) => void;
  requestPause: () => void;
  dismissPauseRequest: () => void;
}

interface Options {
  roomId: string;
  identity: Identity;
  isHost: boolean;
  hostToken?: string | null;
  password?: string;
  /** Guest: FileMeta.id of media already held, read at each (re)join. */
  mediaFileIdRef?: MutableRefObject<string | null>;
}

export function useRoomConnection({
  roomId,
  identity,
  isHost,
  hostToken,
  password,
  mediaFileIdRef,
}: Options): RoomConnection {
  const socket = useMemo(() => {
    const options = {
      // Connection is driven by the lifecycle effect below so React
      // StrictMode's mount/unmount/mount cycle can't strand a dead socket.
      autoConnect: false,
      // BF-06: exponential backoff 500ms -> 8s.
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
      transports: ["websocket", "polling"] as string[],
    };
    // In dev, skip the Vite ws proxy (a known source of dropped socket
    // connections) and talk to the server directly; it already allows CORS.
    return import.meta.env.DEV ? io("http://localhost:3001", options) : io(options);
    // One socket per room visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joinCount, setJoinCount] = useState(0);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [fileMeta, setFileMeta] = useState<FileMeta | null>(null);
  const [bufferStates, setBufferStates] = useState<Record<string, GuestBufferState>>({});
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [pauseRequest, setPauseRequest] = useState<{ user: string; id: string } | null>(null);
  const [hostConnected, setHostConnected] = useState(true);
  const [hostGoneForever, setHostGoneForever] = useState(false);
  const [autoPauseOnBufferLow, setAutoPause] = useState(false);
  const [streamToGuests, setStreamToGuests] = useState(true);
  const [subtitleVtt, setSubtitleVtt] = useState<string | null>(null);
  const [syncPulse, setSyncPulse] = useState(0);

  const offsetRef = useRef(0);
  useEffect(() => {
    offsetRef.current = clockOffset;
  }, [clockOffset]);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  // ---- Clock sync: 5 pings on connect, refresh every 30s (SP-11) ----
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const runSync = async () => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const sample = await new Promise<number[] | null>((resolve) => {
          const clientSend = Date.now();
          const timer = setTimeout(() => resolve(null), 2000);
          socket.emit("clock:ping", { clientTime: clientSend });
          socket.once("clock:response", (data: { serverTime: number }) => {
            clearTimeout(timer);
            resolve([clientSend, data.serverTime, Date.now()]);
          });
        });
        if (cancelled) return;
        if (sample) samples.push(...sample);
        await new Promise((r) => setTimeout(r, 60));
      }
      if (!cancelled && samples.length >= 3) {
        setClockOffset(computeClockOffset(samples));
      }
    };

    const onConnect = () => {
      setConnected(true);
      runSync();
      socket.emit(
        "room:join",
        {
          roomId,
          name: identity.name,
          color: identity.color,
          isHost,
          hostToken,
          password,
          mediaFileId: mediaFileIdRef?.current ?? undefined,
        },
        (res: { ok: boolean; error?: string }) => {
          if (res.ok) {
            setJoined(true);
            setJoinCount((n) => n + 1);
            setJoinError(null);
          } else {
            setJoinError(res.error ?? "Could not join room");
          }
        }
      );
    };

    const onDisconnect = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    interval = setInterval(runSync, 30_000);

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [socket, roomId, identity.name, identity.color, isHost, hostToken, password, mediaFileIdRef]);

  // ---- Room state events ----
  useEffect(() => {
    const pulse = () => setSyncPulse((n) => n + 1);

    const handlers: Record<string, (data: any) => void> = {
      "sync:state": (d) => {
        setPlaybackState(d.playbackState);
        setFileMeta(d.fileMeta ?? null);
        setAutoPause(Boolean(d.autoPauseOnBufferLow));
        setStreamToGuests(d.streamToGuests !== false);
        setHostConnected(Boolean(d.hostConnected));
      },
      "sync:play": (d) => {
        setPlaybackState((s) => ({ ...(s ?? { speed: 1 }), playing: true, currentTime: d.timestamp, updatedAt: d.serverTime, speed: s?.speed ?? 1 }));
        pulse();
      },
      "sync:pause": (d) => {
        setPlaybackState((s) => ({ ...(s ?? { speed: 1 }), playing: false, currentTime: d.timestamp, updatedAt: d.serverTime, speed: s?.speed ?? 1 }));
        pulse();
      },
      "sync:seek": (d) => {
        setPlaybackState((s) =>
          s
            ? { ...s, currentTime: d.targetTimestamp, updatedAt: d.serverTime }
            : { playing: false, currentTime: d.targetTimestamp, updatedAt: d.serverTime, speed: 1 }
        );
        pulse();
      },
      "sync:speed": (d) => {
        setPlaybackState((s) =>
          s ? { ...s, speed: d.speed, currentTime: d.currentTime, updatedAt: d.serverTime } : s
        );
        pulse();
      },
      "sync:heartbeat": (d) => {
        setPlaybackState((s) => (s ? { ...s, currentTime: d.timestamp, updatedAt: d.serverTime } : s));
      },
      "room:users": (d) => setUsers(d.users),
      "chat:history": (d) => setChat(d.messages),
      "chat:message": (d) => setChat((msgs) => [...msgs.slice(-199), d]),
      "file:meta": (d) => {
        setFileMeta(d.fileMeta);
        setPlaybackState({ playing: false, currentTime: 0, updatedAt: d.serverTime, speed: 1 });
      },
      "buffer:states": (d) => setBufferStates(d.states),
      reaction: (d) => {
        setReactions((rs) => [...rs.slice(-30), d]);
        // Reactions self-expire from state after the animation finishes.
        setTimeout(() => setReactions((rs) => rs.filter((r) => r.id !== d.id)), 3500);
      },
      "pause:requested": (d) => setPauseRequest({ user: d.user, id: d.id }),
      "pause:dismissed": () => setPauseRequest(null),
      "host:disconnected": () => setHostConnected(false),
      "host:reconnected": () => {
        setHostConnected(true);
        setHostGoneForever(false);
      },
      "host:gone": () => setHostGoneForever(true),
      "room:auto-pause": (d) => setAutoPause(Boolean(d.enabled)),
      "room:stream-mode": (d) => setStreamToGuests(Boolean(d.enabled)),
      "caption:update": (d) => setSubtitleVtt(d.vttContent),
      "room:closed": () => setJoinError("Room expired"),
    };

    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
    return () => {
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    };
  }, [socket]);

  useEffect(() => {
    socket.connect();
    return () => {
      socket.disconnect();
    };
  }, [socket]);

  const sendChat = useCallback((text: string) => socket.emit("chat:send", { text }), [socket]);
  const sendReaction = useCallback((emoji: string) => socket.emit("reaction:send", { emoji }), [socket]);
  const requestPause = useCallback(() => socket.emit("pause:request"), [socket]);
  const dismissPauseRequest = useCallback(() => {
    socket.emit("pause:dismiss");
    setPauseRequest(null);
  }, [socket]);

  return {
    socket,
    connected,
    joined,
    joinCount,
    joinError,
    users,
    chat,
    playbackState,
    serverNow,
    clockOffset,
    fileMeta,
    bufferStates,
    reactions,
    pauseRequest,
    hostConnected,
    hostGoneForever,
    autoPauseOnBufferLow,
    streamToGuests,
    subtitleVtt,
    syncPulse,
    sendChat,
    sendReaction,
    requestPause,
    dismissPauseRequest,
  };
}
