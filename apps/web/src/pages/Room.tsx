import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRoomConnection } from "../hooks/useRoomConnection";
import { useHostStreamer } from "../hooks/useHostStreamer";
import { useGuestReceiver } from "../hooks/useGuestReceiver";
import { useDriftSync } from "../hooks/useDriftSync";
import { useBufferReporter } from "../hooks/useBufferReporter";
import { useFullscreen } from "../hooks/useFullscreen";
import { useWakeLock } from "../hooks/useWakeLock";
import { togglePictureInPicture } from "../lib/platform";
import { attachDiag, diag, leaveBreadcrumb, markCleanExit, mb, takeStartupCrashReport } from "../lib/diag";
import { storageCapsReady } from "../lib/OpfsStore";
import { Identity, loadIdentity, saveIdentity, loadHostToken } from "../lib/identity";
import { getRoomInfo } from "../lib/api";
import { probeVideoMeta } from "../lib/mp4Meta";
import { toVtt } from "../lib/subtitles";
import { computeExpectedTime } from "../lib/sync";
import { VideoPlayer } from "../components/VideoPlayer/VideoPlayer";
import { ChatPanel } from "../components/Chat/ChatPanel";
import { RoomLobby } from "../components/Room/RoomLobby";
import { GuestList } from "../components/Room/GuestList";
import { CopyLinkButton } from "../components/Room/InviteLink";
import { IdentityForm } from "../components/IdentityForm";
import { FilePickButton } from "../components/FilePickButton";
import { formatTime } from "../components/VideoPlayer/SeekBar";

export default function RoomPage() {
  const { roomId = "" } = useParams();
  const normalizedId = roomId.toUpperCase();
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity());
  const [roomCheck, setRoomCheck] = useState<"loading" | "missing" | "ok">("loading");
  const hostToken = useMemo(() => loadHostToken(normalizedId), [normalizedId]);
  // A host's second tab can choose to just watch (see RoomInner's hostElsewhere).
  const [watchAsViewer, setWatchAsViewer] = useState(false);
  const isHost = hostToken !== null && !watchAsViewer;

  useEffect(() => {
    let cancelled = false;
    getRoomInfo(normalizedId)
      .then((info) => {
        if (cancelled) return;
        setRoomCheck(info?.exists ? "ok" : "missing");
      })
      .catch(() => !cancelled && setRoomCheck("missing"));
    return () => {
      cancelled = true;
    };
  }, [normalizedId]);

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
  // First visit from an invite link: ask who they are before joining.
  // Returning people are remembered (localStorage) and go straight in.
  if (!identity) {
    return (
      <CenteredShell>
        <h1 className="font-display text-3xl">Who's watching?</h1>
        <p className="text-cinema-muted">
          You're joining room <span className="font-mono tracking-widest text-cinema-text">{normalizedId}</span>.
          We'll remember you next time.
        </p>
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

  return (
    <RoomInner
      // Switching role starts a fresh connection with the other role's hooks.
      key={isHost ? "host" : "viewer"}
      roomId={normalizedId}
      identity={identity}
      isHost={isHost}
      hostToken={isHost ? hostToken : null}
      onWatchAsViewer={() => setWatchAsViewer(true)}
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
  onWatchAsViewer: () => void;
}

function RoomInner({ roomId, identity, isHost, hostToken, onWatchAsViewer }: InnerProps) {
  // Guest: id of the file we fully hold, so a reconnect doesn't re-stream it.
  const mediaFileIdRef = useRef<string | null>(null);
  const conn = useRoomConnection({ roomId, identity, isHost, hostToken, mediaFileIdRef });
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(containerRef, videoRef);
  // Don't let the iPad dim and lock mid-movie (locking suspends the page).
  useWakeLock(Boolean(conn.playbackState?.playing));

  // ---- Media sources ----
  const [hostSrc, setHostSrc] = useState<string | null>(null);
  const playbackStateRef = useRef(conn.playbackState);
  playbackStateRef.current = conn.playbackState;
  const { serverNow } = conn;
  const getRoomTime = useCallback(() => {
    const st = playbackStateRef.current;
    return st ? computeExpectedTime(st.playing, st.currentTime, st.speed, st.updatedAt, serverNow()) : null;
  }, [serverNow]);
  const receiver = useGuestReceiver(
    conn.socket,
    conn.joined && !isHost,
    videoRef,
    conn.fileMeta?.id ?? null,
    getRoomTime,
    conn.streamToGuests && conn.hostConnected
  );
  mediaFileIdRef.current = receiver.complete ? receiver.fileId : null;
  const src = isHost ? hostSrc : receiver.src;
  const usingLocalCopy = receiver.mode === "local";

  // ---- Remote diagnostics (see lib/diag.ts) ----
  const crumbRef = useRef("");
  crumbRef.current =
    `${isHost ? "host" : "guest"} src=${src ? (isHost ? "file" : receiver.mode) : "none"}` +
    (isHost ? "" : ` storage=${receiver.streamingOnly ? "window" : "full"} got=${mb(receiver.receivedBytes)}/${mb(receiver.totalBytes)}`) +
    ` playing=${Boolean(conn.playbackState?.playing)}`;
  useEffect(() => attachDiag(conn.socket), [conn.socket]);
  useEffect(() => {
    if (!conn.joined) return;
    storageCapsReady.then((caps) =>
      diag(
        `joined as ${isHost ? "host" : "guest"} | ${navigator.userAgent} | opfs=${caps.opfs} free=${mb(caps.freeBytes)}`
      )
    );
    const crashReport = takeStartupCrashReport();
    if (crashReport) {
      diag(
        `previous page ended abruptly ${Math.round((Date.now() - crashReport.at) / 1000)}s before this load ` +
          `(tab crash / killed by the OS) while: ${crashReport.state}`
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.joined]);
  useEffect(() => {
    const write = () => {
      const v = videoRef.current;
      leaveBreadcrumb(
        roomId,
        `${crumbRef.current} t=${v ? v.currentTime.toFixed(0) : "-"} visible=${document.visibilityState === "visible"}`
      );
    };
    const timer = setInterval(write, 3000);
    const onVisibility = () => {
      diag(`page ${document.visibilityState}`);
      write();
    };
    const onError = (e: ErrorEvent) => diag(`js error: ${e.message} @ ${e.filename}:${e.lineno}`);
    const onRejection = (e: PromiseRejectionEvent) => diag(`unhandled rejection: ${String(e.reason)}`);
    window.addEventListener("pagehide", markCleanExit);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", markCleanExit);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [roomId]);
  // iOS can tear down a backgrounded page's video decoder ("Media failed to
  // decode"). Streaming (MSE) pipelines are rebuilt by the StreamAssembler;
  // a plain file (finished download, own copy, the host's file) just needs
  // reloading, once the page is visible again. The loadedmetadata handlers
  // then put it back at the room's position.
  const receiverModeRef = useRef(receiver.mode);
  receiverModeRef.current = receiver.mode;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let pending = false;
    const reload = () => {
      pending = false;
      diag("reloading the video after an error");
      if (isHost) {
        hostPlayingRef.current = false; // the reload's "pause" isn't a real pause
        resumeSeekRef.current = true;
      }
      v.load();
    };
    const onVideoError = () => {
      diag(`video error: code=${v.error?.code} ${v.error?.message ?? ""} src=${v.currentSrc.slice(0, 5)}`);
      if (!isHost && receiverModeRef.current === "mse") return;
      if (document.visibilityState === "visible") reload();
      else pending = true;
    };
    const onVisible = () => {
      if (pending && document.visibilityState === "visible") reload();
    };
    v.addEventListener("error", onVideoError);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      v.removeEventListener("error", onVideoError);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, isHost]);

  // ---- Local-only audio (PC-03/PC-04) ----
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
    }
  }, [volume, muted, src]);

  // Everyone starts with sound on. Browsers refuse unmuted playback until the
  // viewer has interacted with the page (e.g. a returning guest who opened the
  // link and went straight in), so fall back to muted to keep the picture in
  // sync, and turn sound back on at their first tap, click or key press.
  // iOS Low Power Mode goes further and refuses even muted autoplay; then
  // nothing can play until a tap, so say so.
  const autoMutedRef = useRef(false);
  const playBlockedRef = useRef(false);
  const [playBlocked, setPlayBlocked] = useState(false);
  const markPlayBlocked = useCallback((blocked: boolean) => {
    playBlockedRef.current = blocked;
    setPlayBlocked(blocked);
  }, []);
  const onAutoplayBlocked = useCallback((v: HTMLVideoElement) => {
    const markBlocked = () => markPlayBlocked(true);
    if (v.muted) return markBlocked();
    autoMutedRef.current = true;
    v.muted = true;
    setMuted(true);
    v.play().catch(markBlocked);
  }, [markPlayBlocked]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlaying = () => markPlayBlocked(false);
    v.addEventListener("playing", onPlaying);
    return () => v.removeEventListener("playing", onPlaying);
  }, [src, markPlayBlocked]);
  useEffect(() => {
    const onGesture = (e: Event) => {
      // The mute button / volume slider handle their own first tap; unmuting
      // here as well would make that tap toggle sound straight back off.
      if ((e.target as Element | null)?.closest?.("[data-audio-control]")) return;
      const v = videoRef.current;
      if (autoMutedRef.current) {
        autoMutedRef.current = false;
        if (v) v.muted = false;
        setMuted(false);
      }
      // Must start inside the gesture itself for iOS to allow it. Clear the
      // prompt now (landing on the room's position can take a moment); it
      // comes back if the play is still refused.
      if (playBlockedRef.current && v && playbackStateRef.current?.playing) {
        markPlayBlocked(false);
        v.play().catch((err) => {
          if ((err as DOMException)?.name === "NotAllowedError") markPlayBlocked(true);
        });
      }
    };
    // iOS Safari doesn't fire "click" for taps on non-interactive areas, so
    // also listen for the touch/pointer end that carries the user activation.
    const events = ["touchend", "pointerup", "click", "keydown"];
    for (const t of events) window.addEventListener(t, onGesture);
    return () => {
      for (const t of events) window.removeEventListener(t, onGesture);
    };
  }, [markPlayBlocked]);

  // ---- Guest sync ----
  const { catchingUp } = useDriftSync(
    videoRef,
    conn.playbackState,
    conn.serverNow,
    !isHost && Boolean(src),
    onAutoplayBlocked
  );
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
        if (st.playing) {
          v.play().catch((e) => {
            if ((e as DOMException)?.name === "NotAllowedError") onAutoplayBlocked(v);
          });
        }
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

  // Another tab took over: its streams replace ours.
  useEffect(() => {
    if (isHost && conn.replaced) stopAllStreams();
  }, [isHost, conn.replaced, stopAllStreams]);

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
      if (!st) return;
      v.currentTime = computeExpectedTime(st.playing, st.currentTime, st.speed, st.updatedAt, conn.serverNow());
      // Taking over a room that's still playing (another tab was hosting):
      // join in rather than sit paused while everyone else watches.
      if (st.playing) v.play().catch(() => {});
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

  // Host socket reconnected: re-assert what our video is actually doing (RM-08).
  // Either way the server can be wrong: it paused the room during the outage
  // while our video kept going, or — iPad host leaving Safari — iOS paused our
  // video but that pause went out on an already-dead socket and was lost.
  useEffect(() => {
    if (!isHost || conn.joinCount < 2) return;
    const v = videoRef.current;
    if (!v || v.readyState === 0) return; // no file loaded (yet) — nothing to assert
    hostPlayingRef.current = !v.paused;
    conn.socket.emit(v.paused ? "host:pause" : "host:play", { timestamp: v.currentTime });
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

  const canPlay = Boolean(src);

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
    if (v) togglePictureInPicture(v).catch(() => {});
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

  // Another tab (or window) on this machine is already hosting this room.
  if (conn.hostElsewhere) {
    return (
      <CenteredShell>
        <h1 className="font-display text-3xl">This room is already being hosted</h1>
        <p className="max-w-md text-cinema-muted">
          Another tab or window on this device is hosting room{" "}
          <span className="font-mono tracking-widest text-cinema-text">{roomId}</span>. Only one can control playback.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            className="touch-target rounded-lg bg-cinema-accent px-4 py-2 font-semibold text-white hover:bg-cinema-accent/80"
            onClick={onWatchAsViewer}
          >
            Watch as a viewer
          </button>
          <button
            type="button"
            className="touch-target rounded-lg border border-cinema-accent px-4 py-2 font-semibold text-cinema-accent hover:bg-cinema-accent/10"
            onClick={conn.takeOverHosting}
          >
            Host here instead
          </button>
        </div>
      </CenteredShell>
    );
  }

  // Until the server answers the first join (it may first check whether another
  // tab is hosting), don't show controls this tab might not get.
  if (!conn.joined && !conn.joinError) {
    return (
      <CenteredShell>
        <p className="text-cinema-muted">Joining room…</p>
      </CenteredShell>
    );
  }

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
      {catchingUp && !playBlocked && <OverlayMessage>Catching up…</OverlayMessage>}
      {/* iOS Low Power Mode: even muted playback needs a tap */}
      {!isHost && playBlocked && playing && (
        <OverlayPrompt>
          <p className="font-display text-2xl text-cinema-text">Tap to start playback</p>
          <p className="text-sm text-cinema-muted">Your device is blocking autoplay (Low Power Mode?).</p>
        </OverlayPrompt>
      )}
      {/* Host reloaded the page: the room still has the movie, the browser doesn't */}
      {/* Another tab took over hosting: this one no longer controls anything */}
      {isHost && conn.replaced && (
        <OverlayPrompt>
          <p className="font-display text-2xl text-cinema-text">Hosting moved to another tab</p>
          <p className="text-sm text-cinema-muted">
            Playback is now controlled from another tab or window. Pausing or seeking here won't affect anyone.
          </p>
          <button type="button" className={PROMPT_BUTTON} onClick={conn.takeOverHosting}>
            Host here instead
          </button>
        </OverlayPrompt>
      )}
      {isHost && !conn.replaced && conn.fileMeta && !hostSrc && (
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
          <p className="font-display text-2xl text-cinema-text">
            {receiver.error ? "Can't stream here" : "Connecting to host's stream…"}
          </p>
          {receiver.error && <p className="max-w-md text-sm text-yellow-300">{receiver.error}</p>}
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
      {/* Transfer progress chip */}
      {!isHost && receiver.totalBytes > 0 && !receiver.complete && !receiver.streamingOnly && (
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
          JoshTV
        </Link>
        <span className="font-mono text-sm tracking-widest text-cinema-text/80">{roomId}</span>
        <CopyLinkButton roomId={roomId} />
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
            disableRemotePlayback={!isHost && receiver.mode === "mse" && receiver.managed}
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
                autoMutedRef.current = false;
                setVolume(v);
                setMuted(v === 0);
              },
              onMute: () => {
                // Runs before the window click listener, so the first click on
                // the mute button itself unmutes instead of toggling twice.
                autoMutedRef.current = false;
                setMuted((m) => !m);
              },
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
              roomId={roomId}
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
