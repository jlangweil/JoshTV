import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRoomConnection } from "../hooks/useRoomConnection";
import { useHostStreamer } from "../hooks/useHostStreamer";
import { useGuestReceiver } from "../hooks/useGuestReceiver";
import { useDriftSync } from "../hooks/useDriftSync";
import { useBufferReporter } from "../hooks/useBufferReporter";
import { useFullscreen } from "../hooks/useFullscreen";
import { Identity, loadIdentity, saveIdentity, loadHostToken } from "../lib/identity";
import { getRoomInfo } from "../lib/api";
import { probeVideoMeta } from "../lib/mp4Meta";
import { toVtt } from "../lib/subtitles";
import { isBufferLow } from "../lib/sync";
import { computeExpectedTime } from "../lib/sync";
import { VideoPlayer } from "../components/VideoPlayer/VideoPlayer";
import { ChatPanel } from "../components/Chat/ChatPanel";
import { RoomLobby } from "../components/Room/RoomLobby";
import { GuestList } from "../components/Room/GuestList";
import { IdentityForm } from "../components/IdentityForm";

export default function RoomPage() {
  const { roomId = "" } = useParams();
  const normalizedId = roomId.toUpperCase();
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity());
  const [password, setPassword] = useState<string | null>(null);
  const [roomCheck, setRoomCheck] = useState<"loading" | "missing" | "ok">("loading");
  const [needsPassword, setNeedsPassword] = useState(false);
  const hostToken = useMemo(() => loadHostToken(normalizedId), [normalizedId]);
  const isHost = hostToken !== null;

  useEffect(() => {
    let cancelled = false;
    getRoomInfo(normalizedId)
      .then((info) => {
        if (cancelled) return;
        if (!info?.exists) return setRoomCheck("missing");
        setNeedsPassword(info.hasPassword && !isHost);
        setRoomCheck("ok");
      })
      .catch(() => !cancelled && setRoomCheck("missing"));
    return () => {
      cancelled = true;
    };
  }, [normalizedId, isHost]);

  if (roomCheck === "loading") {
    return <CenteredShell><p className="text-cinema-muted">Looking up room…</p></CenteredShell>;
  }
  if (roomCheck === "missing") {
    return (
      <CenteredShell>
        <h1 className="font-display text-3xl">Room not found</h1>
        <p className="text-cinema-muted">It may have expired. Room codes last 12 hours.</p>
        <Link className="text-cinema-accent underline" to="/">Back home</Link>
      </CenteredShell>
    );
  }
  if (!identity) {
    return (
      <CenteredShell>
        <h1 className="font-display text-3xl">Who's watching?</h1>
        <IdentityForm
          onSubmit={(id) => {
            saveIdentity(id);
            setIdentity(id);
          }}
          submitLabel="Join room"
        />
      </CenteredShell>
    );
  }
  if (needsPassword && password === null) {
    return (
      <CenteredShell>
        <h1 className="font-display text-3xl">This room is locked</h1>
        <form
          className="flex w-full max-w-sm flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("pw");
            setPassword(String(value ?? ""));
          }}
        >
          <input
            name="pw"
            type="password"
            placeholder="Room password"
            className="rounded-lg border border-cinema-surface bg-cinema-bg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-cinema-accent"
            autoFocus
            aria-label="Room password"
          />
          <button type="submit" className="rounded-lg bg-cinema-accent px-4 py-2 font-semibold text-white">
            Enter
          </button>
        </form>
      </CenteredShell>
    );
  }

  return (
    <RoomInner
      roomId={normalizedId}
      identity={identity}
      isHost={isHost}
      hostToken={hostToken}
      password={password ?? undefined}
    />
  );
}

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 p-6 text-center">{children}</div>
  );
}

interface InnerProps {
  roomId: string;
  identity: Identity;
  isHost: boolean;
  hostToken: string | null;
  password?: string;
}

function RoomInner({ roomId, identity, isHost, hostToken, password }: InnerProps) {
  const conn = useRoomConnection({ roomId, identity, isHost, hostToken, password });
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(containerRef);

  // ---- Media sources ----
  const [hostSrc, setHostSrc] = useState<string | null>(null);
  const receiver = useGuestReceiver(conn.socket, conn.joined && !isHost, videoRef);
  const src = isHost ? hostSrc : receiver.src;

  // ---- Local-only audio (PC-03/PC-04) ----
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(!isHost); // guests start muted for autoplay
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
    }
  }, [volume, muted, src]);

  // ---- Guest sync ----
  const { catchingUp } = useDriftSync(videoRef, conn.playbackState, conn.serverNow, !isHost && Boolean(src));
  useBufferReporter(
    conn.socket,
    videoRef,
    conn.joined && !isHost && Boolean(src),
    receiver.receivedBytes,
    receiver.complete
  );

  // Guest: when the src swaps (MSE -> blob), land at the synced position.
  useEffect(() => {
    if (isHost || !src) return;
    const v = videoRef.current;
    if (!v) return;
    const onLoaded = () => {
      const st = conn.playbackState;
      if (st) {
        v.currentTime = computeExpectedTime(st.playing, st.currentTime, st.speed, st.updatedAt, conn.serverNow());
        if (st.playing) v.play().catch(() => {});
      }
    };
    v.addEventListener("loadedmetadata", onLoaded);
    return () => v.removeEventListener("loadedmetadata", onLoaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, isHost]);

  // ---- Host: file pick & streaming ----
  const streamer = useHostStreamer(conn.socket, conn.joined && isHost);
  const guestIds = conn.users.filter((u) => !u.isHost).map((u) => u.id);
  const guestIdsRef = useRef(guestIds);
  guestIdsRef.current = guestIds;

  const pickFile = useCallback(
    async (file: File) => {
      const meta = await probeVideoMeta(file).catch(() => ({ duration: 0, width: 0, height: 0 }));
      setHostSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      conn.socket.emit("host:file-meta", { name: file.name, size: file.size, ...meta });
      streamer.setFile(file, guestIdsRef.current);
    },
    [conn.socket, streamer]
  );

  // ---- Host controls ----
  const emitPlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {});
    conn.socket.emit("host:play", { timestamp: v.currentTime });
  }, [conn.socket]);

  const emitPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    conn.socket.emit("host:pause", { timestamp: v.currentTime });
  }, [conn.socket]);

  const emitSeek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = t;
      conn.socket.emit("host:seek", { targetTimestamp: t });
    },
    [conn.socket]
  );

  const emitSpeed = useCallback(
    (s: number) => {
      const v = videoRef.current;
      if (v) v.playbackRate = s;
      conn.socket.emit("host:speed", { speed: s });
    },
    [conn.socket]
  );

  // Host heartbeat keeps long sessions anchored to the real playhead.
  useEffect(() => {
    if (!isHost || !conn.joined) return;
    const interval = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused) conn.socket.emit("host:heartbeat", { timestamp: v.currentTime });
    }, 10_000);
    return () => clearInterval(interval);
  }, [isHost, conn.joined, conn.socket]);

  // ---- Buffering gate (SP-10) + auto-pause (BF-04) ----
  const [bufferingGate, setBufferingGate] = useState(true);
  const allGuestsReady =
    guestIds.length === 0 ||
    guestIds.every((id) => {
      const st = conn.bufferStates[id];
      return st ? st.ready || st.complete : false;
    });
  const canPlay = Boolean(src) && (!bufferingGate || allGuestsReady);

  // BF-04 with hysteresis: pause when a guest drops low, but only resume once
  // everyone has 15s+ of runway (or finished downloading). Resuming right at
  // the 5s threshold would drain immediately and flap pause/play forever.
  const autoPausedRef = useRef(false);
  useEffect(() => {
    if (!isHost || !conn.autoPauseOnBufferLow) return;
    const states = guestIds.map((id) => conn.bufferStates[id]).filter(Boolean);
    const anyLow = states.some((st) => !st.complete && isBufferLow(st.aheadSeconds));
    const allRecovered = states.every((st) => st.complete || st.aheadSeconds >= 15);
    if (conn.playbackState?.playing && anyLow && !autoPausedRef.current) {
      autoPausedRef.current = true;
      emitPause();
    } else if (!conn.playbackState?.playing && autoPausedRef.current && allRecovered) {
      autoPausedRef.current = false;
      emitPlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.bufferStates, conn.autoPauseOnBufferLow, conn.playbackState?.playing, isHost]);

  // ---- Subtitles ----
  const subtitleUrl = useMemo(() => {
    if (!conn.subtitleVtt) return null;
    return URL.createObjectURL(new Blob([conn.subtitleVtt], { type: "text/vtt" }));
  }, [conn.subtitleVtt]);
  useEffect(() => {
    return () => {
      if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    };
  }, [subtitleUrl]);

  const onCaptionFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      conn.socket.emit("caption:upload", { vttContent: toVtt(text, file.name) });
    },
    [conn.socket]
  );

  const onPip = useCallback(() => {
    const v = videoRef.current;
    if (v && document.pictureInPictureEnabled) {
      (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(
        () => {}
      );
    }
  }, []);

  // ---- Chat open/unread ----
  const [chatOpen, setChatOpen] = useState(true);
  const seenCountRef = useRef(0);
  if (chatOpen) seenCountRef.current = conn.chat.length;
  const unreadCount = chatOpen ? 0 : Math.max(0, conn.chat.length - seenCountRef.current);

  // ---- Keyboard (accessibility / shortcuts) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === " " && isHost) {
        e.preventDefault();
        conn.playbackState?.playing ? emitPause() : canPlay && emitPlay();
      } else if (e.key.toLowerCase() === "f") {
        toggleFullscreen();
      } else if (e.key.toLowerCase() === "c") {
        setChatOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isHost, conn.playbackState?.playing, canPlay, emitPause, emitPlay, toggleFullscreen]);

  // ---- Join errors ----
  if (conn.joinError) {
    return (
      <CenteredShell>
        <h1 className="font-display text-3xl">{conn.joinError}</h1>
        <Link className="text-cinema-accent underline" to="/">Back home</Link>
      </CenteredShell>
    );
  }

  const playing = conn.playbackState?.playing ?? false;
  const duration = conn.fileMeta?.duration || videoRef.current?.duration || 0;
  const transferPct =
    receiver.totalBytes > 0 ? Math.floor((receiver.receivedBytes / receiver.totalBytes) * 100) : 0;

  const overlay = (
    <>
      {/* RM-07: host outage overlay */}
      {!isHost && conn.joined && !conn.hostConnected && (
        <OverlayMessage>
          {conn.hostGoneForever ? "The host left the room." : "Host disconnected — waiting to reconnect…"}
        </OverlayMessage>
      )}
      {/* Own-connection outage */}
      {!conn.connected && conn.joined && <OverlayMessage>Reconnecting…</OverlayMessage>}
      {/* SP-07 */}
      {catchingUp && <OverlayMessage>Catching up…</OverlayMessage>}
      {/* Guest stream startup */}
      {!isHost && conn.fileMeta && !src && <OverlayMessage>Connecting to host's stream…</OverlayMessage>}
      {/* Guest unmute prompt (autoplay policy) */}
      {!isHost && muted && src && playing && (
        <button
          type="button"
          className="absolute bottom-20 left-1/2 z-20 -translate-x-1/2 rounded-full bg-cinema-accent px-4 py-2 text-sm font-semibold text-white shadow-lg"
          onClick={() => setMuted(false)}
        >
          {"\u{1F50A}"} Tap to unmute
        </button>
      )}
      {/* Transfer progress chip */}
      {!isHost && receiver.totalBytes > 0 && !receiver.complete && (
        <div className="absolute bottom-20 right-3 z-20 rounded-lg bg-black/60 px-2 py-1 font-mono text-xs text-cinema-text/90">
          buffering {transferPct}%
        </div>
      )}
      {receiver.error && !receiver.complete && (
        <div className="absolute right-3 top-3 z-20 max-w-xs rounded-lg bg-black/70 px-2 py-1 text-xs text-yellow-300">
          {receiver.error}
        </div>
      )}
      {/* SP-09: pause requests */}
      {conn.pauseRequest && (
        <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-sm">
          <span>
            {"✋"} {conn.pauseRequest.user} requested a pause
          </span>
          {isHost && (
            <>
              <button
                type="button"
                className="rounded bg-cinema-accent px-2 py-0.5 text-xs font-semibold text-white"
                onClick={() => {
                  emitPause();
                  conn.dismissPauseRequest();
                }}
              >
                Pause
              </button>
              <button
                type="button"
                className="rounded bg-cinema-surface px-2 py-0.5 text-xs"
                onClick={conn.dismissPauseRequest}
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
    </>
  );

  const chatPanel = (
    <ChatPanel
      messages={conn.chat}
      users={conn.users}
      roomId={roomId}
      onSend={conn.sendChat}
      overlay={isFullscreen}
      open={chatOpen}
      onClose={() => setChatOpen(false)}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-cinema-surface bg-cinema-panel px-4 py-2">
        <Link to="/" className="font-display text-xl text-cinema-accent">
          SyncCine
        </Link>
        <span className="font-mono text-sm tracking-widest text-cinema-text/80">{roomId}</span>
        {conn.fileMeta && (
          <span className="hidden truncate text-xs text-cinema-muted sm:inline" title={conn.fileMeta.name}>
            {conn.fileMeta.name}
            {conn.fileMeta.width > 0 && ` · ${conn.fileMeta.width}x${conn.fileMeta.height}`}
          </span>
        )}
        <div className="grow" />
        <GuestList users={conn.users} bufferStates={conn.bufferStates} showBufferDots={isHost} />
        {isHost && (
          <div className="flex items-center gap-3 text-xs">
            <label className="flex cursor-pointer items-center gap-1" title="Play only starts when every viewer is buffered">
              <input
                type="checkbox"
                checked={bufferingGate}
                onChange={(e) => setBufferingGate(e.target.checked)}
              />
              Buffering gate
            </label>
            <label className="flex cursor-pointer items-center gap-1" title="Pause everyone if any viewer runs low">
              <input
                type="checkbox"
                checked={conn.autoPauseOnBufferLow}
                onChange={(e) => conn.socket.emit("host:auto-pause", { enabled: e.target.checked })}
              />
              Auto-pause
            </label>
            <label className="cursor-pointer rounded-lg bg-cinema-surface px-2 py-1 hover:bg-cinema-surface/70">
              {conn.fileMeta ? "Replace video" : "Load video"}
              <input
                type="file"
                accept="video/mp4,video/webm"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        )}
      </header>

      <main className="flex min-h-0 grow flex-col lg:flex-row">
        {conn.fileMeta ? (
          <VideoPlayer
            videoRef={videoRef}
            containerRef={containerRef}
            src={src}
            subtitleUrl={subtitleUrl}
            muted={muted}
            playing={playing}
            reactions={conn.reactions}
            syncPulse={conn.syncPulse}
            isFullscreen={isFullscreen}
            fullscreenChat={chatPanel}
            fullscreenBadge={
              <span>
                {roomId} · {"\u{1F464}"} {guestIds.length}
              </span>
            }
            overlay={overlay}
            controls={{
              isHost,
              playing,
              duration,
              volume,
              muted,
              speed: conn.playbackState?.speed ?? 1,
              canPlay,
              onPlay: emitPlay,
              onPause: emitPause,
              onSeek: emitSeek,
              onVolume: (v) => {
                setVolume(v);
                setMuted(v === 0);
              },
              onMute: () => setMuted((m) => !m),
              onSpeed: emitSpeed,
              onFullscreen: toggleFullscreen,
              onPip,
              onCaptionFile,
              onReact: conn.sendReaction,
              onRequestPause: conn.requestPause,
              onToggleChat: () => setChatOpen((o) => !o),
              unreadCount,
            }}
          />
        ) : (
          <div className="min-h-0 grow">
            <RoomLobby
              isHost={isHost}
              users={conn.users}
              bufferStates={conn.bufferStates}
              onPickFile={isHost ? pickFile : undefined}
            />
          </div>
        )}
        {!isFullscreen && chatPanel}
      </main>
    </div>
  );
}

function OverlayMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
      <p className="font-display text-2xl text-cinema-text">{children}</p>
    </div>
  );
}
