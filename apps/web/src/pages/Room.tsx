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
import { FilePickButton } from "../components/FilePickButton";
import { formatTime } from "../components/VideoPlayer/SeekBar";

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
  // Guest: id of the file we fully hold, so a reconnect doesn't re-stream it.
  const mediaFileIdRef = useRef<string | null>(null);
  const conn = useRoomConnection({ roomId, identity, isHost, hostToken, password, mediaFileIdRef });
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(containerRef);

  // ---- Media sources ----
  const [hostSrc, setHostSrc] = useState<string | null>(null);
  const receiver = useGuestReceiver(conn.socket, conn.joined && !isHost, videoRef, conn.fileMeta?.id ?? null);
  mediaFileIdRef.current = receiver.complete ? receiver.fileId : null;
  const src = isHost ? hostSrc : receiver.src;
  const usingLocalCopy = receiver.mode === "local";

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
    receiver.fileId,
    receiver.receivedBytes,
    receiver.complete,
    usingLocalCopy
  );

  // ---- Guest: play your own copy instead of the host's stream ----
  const { loadLocalFile } = receiver;
  const [localWarning, setLocalWarning] = useState<string | null>(null);
  const pickLocalCopy = useCallback(
    async (file: File) => {
      const expected = conn.fileMeta;
      loadLocalFile(file);
      setLocalWarning(null);
      // Byte-identical copies are the common case; otherwise sanity-check length.
      if (!expected || file.size === expected.size) return;
      const meta = await probeVideoMeta(file).catch(() => null);
      if (meta && meta.duration > 0 && expected.duration > 0 && Math.abs(meta.duration - expected.duration) > 2) {
        setLocalWarning(
          `Your file runs ${formatTime(meta.duration)} but the host's runs ${formatTime(expected.duration)}. ` +
            `It may be a different cut, so scenes won't line up.`
        );
      }
    },
    [conn.fileMeta, loadLocalFile]
  );
  useEffect(() => setLocalWarning(null), [conn.fileMeta?.id]);

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
  const { setFile: setStreamFile, stopAll: stopAllStreams } = useHostStreamer(conn.socket, conn.joined && isHost);
  const guestIds = conn.users.filter((u) => !u.isHost).map((u) => u.id);
  const guestIdsRef = useRef(guestIds);
  guestIdsRef.current = guestIds;
  const streamToGuestsRef = useRef(conn.streamToGuests);
  streamToGuestsRef.current = conn.streamToGuests;
  /** Whether we've told the server we're playing; the host <video> is the source of truth. */
  const hostPlayingRef = useRef(false);
  /** After a page reload + re-pick, land on the room's saved position. */
  const resumeSeekRef = useRef(false);

  const pickFile = useCallback(
    async (file: File) => {
      const current = conn.fileMeta;
      // Swapping src fires a "pause" that must not be broadcast.
      hostPlayingRef.current = false;
      const resuming =
        !hostSrc && current !== null && current.name === file.name && current.size === file.size;
      if (resuming) {
        // Host reloaded and re-picked the same movie: keep the room's position
        // and only stream to guests that don't already have it.
        resumeSeekRef.current = true;
        setHostSrc(URL.createObjectURL(file));
        setStreamFile(file, current.id, []);
        conn.socket.emit("host:resume-file");
        return;
      }
      const meta = await probeVideoMeta(file).catch(() => ({ duration: 0, width: 0, height: 0 }));
      setHostSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      conn.socket.emit(
        "host:file-meta",
        { name: file.name, size: file.size, ...meta },
        (res: { id: string }) =>
          setStreamFile(file, res.id, streamToGuestsRef.current ? guestIdsRef.current : [])
      );
    },
    [conn.socket, conn.fileMeta, hostSrc, setStreamFile]
  );

  const setStreamMode = useCallback(
    (enabled: boolean) => {
      if (!enabled) stopAllStreams();
      conn.socket.emit("host:stream-mode", { enabled });
    },
    [conn.socket, stopAllStreams]
  );

  // ---- Host controls ----
  // play/pause only drive the element; its events do the broadcasting, so
  // pauses from outside these controls (movie ended, PiP window, media keys)
  // reach guests too instead of leaving them stuck on "Catching up…".
  const emitPlay = useCallback(() => {
    videoRef.current?.play().catch(() => {});
  }, []);

  const emitPause = useCallback(() => {
    videoRef.current?.pause();
  }, []);

  const hasFile = conn.fileMeta !== null;
  useEffect(() => {
    const v = videoRef.current;
    if (!isHost || !v) return;
    const onPlay = () => {
      if (hostPlayingRef.current) return;
      hostPlayingRef.current = true;
      conn.socket.emit("host:play", { timestamp: v.currentTime });
    };
    const onPause = () => {
      if (!hostPlayingRef.current) return;
      hostPlayingRef.current = false;
      conn.socket.emit("host:pause", { timestamp: v.currentTime });
    };
    const onLoaded = () => {
      if (!resumeSeekRef.current) return;
      resumeSeekRef.current = false;
      const st = conn.playbackState;
      if (st) v.currentTime = computeExpectedTime(st.playing, st.currentTime, st.speed, st.updatedAt, conn.serverNow());
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    v.addEventListener("loadedmetadata", onLoaded);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      v.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [isHost, hasFile, conn.socket, conn.playbackState, conn.serverNow]);

  // Host socket reconnected: the server paused the room during the outage
  // while our video kept going, so re-assert and let guests resume (RM-08).
  useEffect(() => {
    if (!isHost || conn.joinCount < 2) return;
    const v = videoRef.current;
    if (v && !v.paused) {
      hostPlayingRef.current = true;
      conn.socket.emit("host:play", { timestamp: v.currentTime });
    }
  }, [isHost, conn.joinCount, conn.socket]);

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
      {/* Host reloaded the page: the room still has the movie, the browser doesn't */}
      {isHost && conn.fileMeta && !hostSrc && (
        <OverlayPrompt>
          <p className="font-display text-2xl text-cinema-text">Re-select your video to continue</p>
          <p className="text-sm text-cinema-muted">
            Pick <span className="text-cinema-text">{conn.fileMeta.name}</span> again to resume where the room left
            off, or pick a different file to start over.
          </p>
          <FilePickButton onPick={pickFile} className={PROMPT_BUTTON}>
            Choose file
          </FilePickButton>
        </OverlayPrompt>
      )}
      {/* Guest stream startup */}
      {!isHost && conn.fileMeta && !src && conn.streamToGuests && (
        <OverlayPrompt>
          <p className="font-display text-2xl text-cinema-text">Connecting to host's stream…</p>
          <p className="text-sm text-cinema-muted">Already have this movie on your computer?</p>
          <FilePickButton onPick={pickLocalCopy} className={PROMPT_BUTTON}>
            Use my own copy
          </FilePickButton>
        </OverlayPrompt>
      )}
      {/* Host isn't streaming: every guest brings their own copy */}
      {!isHost && conn.fileMeta && !conn.streamToGuests && !receiver.complete && (
        <OverlayPrompt>
          <p className="font-display text-2xl text-cinema-text">Load your copy of the movie</p>
          <p className="text-sm text-cinema-muted">
            The host isn't streaming. Everyone plays their own copy of{" "}
            <span className="text-cinema-text">{conn.fileMeta.name}</span>, kept in sync.
          </p>
          <FilePickButton onPick={pickLocalCopy} className={PROMPT_BUTTON}>
            Choose file
          </FilePickButton>
        </OverlayPrompt>
      )}
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
        <div className="absolute bottom-20 right-3 z-20 flex items-center gap-2 rounded-lg bg-black/60 px-2 py-1 font-mono text-xs text-cinema-text/90">
          buffering {transferPct}%
          <FilePickButton
            onPick={pickLocalCopy}
            className="cursor-pointer font-sans text-cinema-accent underline"
            title="Skip the download and play the movie from your own computer"
          >
            use my copy
          </FilePickButton>
        </div>
      )}
      {localWarning && (
        <div className="absolute left-3 top-3 z-20 max-w-sm rounded-lg bg-black/70 px-2 py-1 text-xs text-yellow-300">
          {localWarning}
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
            <label
              className="flex cursor-pointer items-center gap-1"
              title="Off: viewers load their own copy of the file and nothing is sent from your computer"
            >
              <input
                type="checkbox"
                checked={conn.streamToGuests}
                onChange={(e) => setStreamMode(e.target.checked)}
              />
              Stream to viewers
            </label>
            <label className="flex cursor-pointer items-center gap-1" title="Pause everyone if any viewer runs low">
              <input
                type="checkbox"
                checked={conn.autoPauseOnBufferLow}
                onChange={(e) => conn.socket.emit("host:auto-pause", { enabled: e.target.checked })}
              />
              Auto-pause
            </label>
            <FilePickButton onPick={pickFile}>{conn.fileMeta ? "Replace video" : "Load video"}</FilePickButton>
          </div>
        )}
        {!isHost && conn.fileMeta && (
          <div className="flex items-center gap-2 text-xs">
            {usingLocalCopy && (
              <span className="rounded-full bg-cinema-surface px-2 py-1 text-cinema-muted" title="Playing from your computer">
                own copy
              </span>
            )}
            <FilePickButton
              onPick={pickLocalCopy}
              title="Play the movie from a file on your computer instead of the host's stream"
            >
              {usingLocalCopy ? "Change file" : "Use my own copy"}
            </FilePickButton>
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

const PROMPT_BUTTON =
  "cursor-pointer rounded-lg bg-cinema-accent px-4 py-2 font-semibold text-white hover:bg-cinema-accent/80 focus-within:ring-2 focus-within:ring-white";

function OverlayPrompt({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center">
      {children}
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
