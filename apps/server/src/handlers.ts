import { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import { getRoom, pushChat, systemMessage, touch, deleteRoom } from "./rooms.js";
import {
  Room,
  RoomUser,
  GuestBufferState,
  MAX_GUESTS,
  CHAT_HISTORY_ON_JOIN,
  HOST_GRACE_MS,
} from "./types.js";

interface SocketCtx {
  roomId: string | null;
  isHost: boolean;
  name: string;
  color: string;
  /** Sliding-window timestamps for chat rate limiting (CH-10). */
  chatTimes: number[];
  /** Sliding-window timestamps for client diagnostics rate limiting. */
  diagTimes: number[];
}

/** One console line per event, tagged with room and person. */
function logLine(roomId: string | null, who: string, text: string): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time} [${roomId ?? "------"}] ${who || "?"}: ${text}`);
}

const ctxBySocket = new Map<string, SocketCtx>();

function usersPayload(room: Room) {
  return [...room.users.values()].map((u) => ({
    id: u.socketId,
    name: u.name,
    color: u.color,
    isHost: u.isHost,
  }));
}

function bufferStatesPayload(room: Room) {
  const out: Record<string, GuestBufferState> = {};
  for (const [sid, st] of room.guestBufferStates) out[sid] = st;
  return out;
}

function requireHost(room: Room, socket: Socket): boolean {
  return room.hostSocketId === socket.id;
}

/** Ask the host to stream to every guest that doesn't already hold the current file. */
function requestMissingStreams(io: Server, room: Room): void {
  if (!room.fileMeta || !room.hostSocketId || !room.streamToGuests) return;
  for (const u of room.users.values()) {
    if (u.isHost || room.guestBufferStates.get(u.socketId)?.complete) continue;
    io.to(room.hostSocketId).emit("stream:request", { guestSocketId: u.socketId });
  }
}

export function registerHandlers(io: Server, socket: Socket): void {
  const ctx: SocketCtx = { roomId: null, isHost: false, name: "", color: "", chatTimes: [], diagTimes: [] };
  ctxBySocket.set(socket.id, ctx);

  const currentRoom = (): Room | undefined =>
    ctx.roomId ? getRoom(ctx.roomId) : undefined;

  // ---- Clock sync (SP-11) ----
  // With an ack callback it doubles as a liveness probe: a client returning
  // from the background uses it to tell a live socket from a dead one.
  socket.on("clock:ping", (data: { clientTime: number }, ack?: (res: unknown) => void) => {
    const res = { clientTime: data?.clientTime ?? 0, serverTime: Date.now() };
    if (typeof ack === "function") ack(res);
    else socket.emit("clock:response", res);
  });

  // ---- Join ----
  socket.on(
    "room:join",
    async (
      data: {
        roomId: string;
        name: string;
        color: string;
        isHost: boolean;
        hostToken?: string;
        /** File id the guest already holds (finished download or local copy). */
        mediaFileId?: string;
        /**
         * Host only: take over even if another tab is hosting. Set for a tab
         * reconnecting after it was already the host, or when the person
         * chose "Host here instead".
         */
        takeover?: boolean;
      },
      ack?: (res: { ok: boolean; error?: string }) => void
    ) => {
      const room = getRoom(String(data?.roomId ?? ""));
      if (!room) return ack?.({ ok: false, error: "Room not found" });

      const name = String(data?.name ?? "").slice(0, 24).trim() || "Anonymous";
      const color = String(data?.color ?? "#A8DADC").slice(0, 9);

      if (data.isHost) {
        if (data.hostToken !== room.hostToken) {
          return ack?.({ ok: false, error: "Invalid host token" });
        }
        // The host token lives in the browser, so a second tab (or window) on
        // the host's machine arrives with it too. Never let that silently
        // steal hosting: if the current host tab is alive, ask first.
        const prevId = room.hostSocketId;
        const prev = prevId && prevId !== socket.id ? io.sockets.sockets.get(prevId) : undefined;
        if (prev?.connected && !data.takeover) {
          // "Connected" can be stale (an iPad host that left Safari): confirm it answers.
          const alive = await prev
            .timeout(2000)
            .emitWithAck("host:ping")
            .then(() => true)
            .catch(() => false);
          if (alive) return ack?.({ ok: false, error: "host-elsewhere" });
        }
        if (prev?.connected) {
          // The old tab stays in the room as a viewer and is told why.
          const prevUser = room.users.get(prev.id);
          if (prevUser) prevUser.isHost = false;
          const prevCtx = ctxBySocket.get(prev.id);
          if (prevCtx) prevCtx.isHost = false;
          prev.emit("host:replaced");
          logLine(room.roomId, prevUser?.name ?? "?", "hosting taken over by another tab");
        }
        // Host (re)connecting — cancel the disconnect grace timer (RM-08) and
        // tell guests, even if the grace period already ran out.
        if (room.hostGraceTimer) {
          clearTimeout(room.hostGraceTimer);
          room.hostGraceTimer = null;
        }
        if (prevId === null) io.to(room.roomId).emit("host:reconnected");
        room.hostSocketId = socket.id;
        // Guests' peer connections to the host's previous socket are likely
        // dead (e.g. an iPad host left Safari): re-offer to anyone still missing
        // the file. Guests resume their downloads rather than restarting.
        setTimeout(() => requestMissingStreams(io, room), 500);
      } else {
        const guestCount = [...room.users.values()].filter((u) => !u.isHost).length;
        if (guestCount >= MAX_GUESTS) {
          return ack?.({ ok: false, error: "Room is full" });
        }
      }

      ctx.roomId = room.roomId;
      ctx.isHost = data.isHost;
      ctx.name = name;
      ctx.color = color;

      const user: RoomUser = { socketId: socket.id, name, color, isHost: data.isHost };
      room.users.set(socket.id, user);
      touch(room);
      socket.join(room.roomId);

      ack?.({ ok: true });
      logLine(room.roomId, name, `joined as ${data.isHost ? "host" : "guest"} (socket ${socket.id})`);

      // Full state for the joiner (sync:state on join/reconnect).
      socket.emit("sync:state", {
        playbackState: room.playbackState,
        serverTime: Date.now(),
        fileMeta: room.fileMeta,
        streamToGuests: room.streamToGuests,
        hostConnected: room.hostSocketId !== null,
      });
      socket.emit("chat:history", {
        messages: room.chatHistory.slice(-CHAT_HISTORY_ON_JOIN),
      });
      if (room.subtitleVtt) {
        socket.emit("caption:update", { vttContent: room.subtitleVtt });
      }
      io.to(room.roomId).emit("room:users", { users: usersPayload(room) });
      socket.to(room.roomId).emit("room:join", { user: { id: socket.id, name, color } });

      const sys = systemMessage(room, `${name} joined`);
      io.to(room.roomId).emit("chat:message", sys);

      if (
        !data.isHost &&
        room.fileMeta &&
        room.hostSocketId &&
        room.streamToGuests &&
        data.mediaFileId !== room.fileMeta.id
      ) {
        // Ask the host to open a WebRTC stream toward this guest. Guests that
        // reconnect already holding the file (download or local copy) skip it.
        io.to(room.hostSocketId).emit("stream:request", { guestSocketId: socket.id });
      }
    }
  );

  // ---- Host playback events (SP-01..SP-04, PC-05) ----
  socket.on("host:play", (data: { timestamp: number }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    const now = Date.now();
    room.playbackState = { ...room.playbackState, playing: true, currentTime: Number(data?.timestamp) || 0, updatedAt: now };
    touch(room);
    io.to(room.roomId).emit("sync:play", { timestamp: room.playbackState.currentTime, serverTime: now });
  });

  socket.on("host:pause", (data: { timestamp: number }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    const now = Date.now();
    room.playbackState = { ...room.playbackState, playing: false, currentTime: Number(data?.timestamp) || 0, updatedAt: now };
    touch(room);
    io.to(room.roomId).emit("sync:pause", { timestamp: room.playbackState.currentTime, serverTime: now });
  });

  socket.on("host:seek", (data: { targetTimestamp: number }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    const now = Date.now();
    const target = Number(data?.targetTimestamp) || 0;
    room.playbackState = { ...room.playbackState, currentTime: target, updatedAt: now };
    touch(room);
    io.to(room.roomId).emit("sync:seek", { targetTimestamp: target, serverTime: now });
  });

  socket.on("host:speed", (data: { speed: number }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    const now = Date.now();
    const speed = [0.5, 0.75, 1, 1.25, 1.5].includes(Number(data?.speed)) ? Number(data.speed) : 1;
    // Re-anchor currentTime so position stays continuous across speed change.
    const st = room.playbackState;
    const elapsed = st.playing ? ((now - st.updatedAt) / 1000) * st.speed : 0;
    room.playbackState = { ...st, currentTime: st.currentTime + elapsed, speed, updatedAt: now };
    touch(room);
    io.to(room.roomId).emit("sync:speed", { speed, serverTime: now, currentTime: room.playbackState.currentTime });
  });

  // Periodic position report while playing; keeps guests' derived position
  // anchored to the host's real playhead over long sessions.
  socket.on("host:heartbeat", (data: { timestamp: number }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket) || !room.playbackState.playing) return;
    const now = Date.now();
    room.playbackState = { ...room.playbackState, currentTime: Number(data?.timestamp) || 0, updatedAt: now };
    touch(room);
    socket.to(room.roomId).emit("sync:heartbeat", { timestamp: room.playbackState.currentTime, serverTime: now });
  });

  // ---- File metadata (FL-03/FL-04) ----
  socket.on(
    "host:file-meta",
    (
      data: { name: string; size: number; duration: number; width: number; height: number },
      ack?: (res: { id: string }) => void
    ) => {
      const room = currentRoom();
      if (!room || !requireHost(room, socket)) return;
      const replacing = room.fileMeta !== null;
      room.fileMeta = {
        id: randomUUID(),
        name: String(data?.name ?? "video.mp4").slice(0, 200),
        size: Number(data?.size) || 0,
        duration: Number(data?.duration) || 0,
        width: Number(data?.width) || 0,
        height: Number(data?.height) || 0,
      };
      room.playbackState = { playing: false, currentTime: 0, updatedAt: Date.now(), speed: 1 };
      room.guestBufferStates.clear();
      touch(room);
      ack?.({ id: room.fileMeta.id });
      io.to(room.roomId).emit("file:meta", { fileMeta: room.fileMeta, serverTime: Date.now() });
      io.to(room.roomId).emit("buffer:states", { states: bufferStatesPayload(room) });
      const sys = systemMessage(
        room,
        replacing ? `Host changed the video: ${room.fileMeta.name}` : `Now playing: ${room.fileMeta.name}`
      );
      io.to(room.roomId).emit("chat:message", sys);
    }
  );

  // Host reloaded the page and re-picked the same file: keep the room's
  // position and only stream to guests that don't already have it.
  socket.on("host:resume-file", () => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    requestMissingStreams(io, room);
  });

  // Off = "everyone brings their own copy": the host streams to no one.
  socket.on("host:stream-mode", (data: { enabled: boolean }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    room.streamToGuests = Boolean(data?.enabled);
    io.to(room.roomId).emit("room:stream-mode", { enabled: room.streamToGuests });
    requestMissingStreams(io, room);
  });

  // Guest's stream stalled (connection dropped while it was in the background, etc.).
  socket.on("guest:stream-request", () => {
    const room = currentRoom();
    if (!room || ctx.isHost || !room.fileMeta || !room.hostSocketId || !room.streamToGuests) return;
    if (room.guestBufferStates.get(socket.id)?.complete) return;
    io.to(room.hostSocketId).emit("stream:request", { guestSocketId: socket.id });
  });

  // ---- Guest buffer reports (BF-02/BF-03) ----
  socket.on(
    "guest:buffer",
    (data: {
      fileId: string | null;
      aheadSeconds: number;
      ready: boolean;
      receivedBytes: number;
      complete: boolean;
      local: boolean;
    }) => {
      const room = currentRoom();
      if (!room || ctx.isHost) return;
      // Reports about a replaced file would falsely open the buffering gate.
      if (!room.fileMeta || data?.fileId !== room.fileMeta.id) return;
      room.guestBufferStates.set(socket.id, {
        aheadSeconds: Number(data?.aheadSeconds) || 0,
        ready: Boolean(data?.ready),
        receivedBytes: Number(data?.receivedBytes) || 0,
        complete: Boolean(data?.complete),
        local: Boolean(data?.local),
      });
      io.to(room.roomId).emit("buffer:states", { states: bufferStatesPayload(room) });
    }
  );

  // ---- Chat (CH-*) ----
  socket.on("chat:send", (data: { text: string }) => {
    const room = currentRoom();
    if (!room) return;
    // CH-10: max 3 messages per second per user.
    const now = Date.now();
    ctx.chatTimes = ctx.chatTimes.filter((t) => now - t < 1000);
    if (ctx.chatTimes.length >= 3) return;
    ctx.chatTimes.push(now);

    const text = String(data?.text ?? "").slice(0, 500).trim();
    if (!text) return;
    const msg = {
      id: randomUUID(),
      user: ctx.name,
      color: ctx.color,
      text,
      ts: now,
    };
    pushChat(room, msg);
    io.to(room.roomId).emit("chat:message", msg);
  });

  // ---- Reactions (RC-*) ----
  socket.on("reaction:send", (data: { emoji: string }) => {
    const room = currentRoom();
    if (!room) return;
    const allowed = ["\u{1F44F}", "\u{1F602}", "\u{1F631}", "\u{2764}\u{FE0F}", "\u{1F525}"];
    const emoji = allowed.includes(data?.emoji) ? data.emoji : allowed[0];
    io.to(room.roomId).emit("reaction", { emoji, user: ctx.name, id: randomUUID() });
  });

  // ---- Pause request (SP-09) ----
  socket.on("pause:request", () => {
    const room = currentRoom();
    if (!room || ctx.isHost) return;
    io.to(room.roomId).emit("pause:requested", { user: ctx.name, id: socket.id });
  });

  socket.on("pause:dismiss", () => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    io.to(room.roomId).emit("pause:dismissed");
  });

  // ---- Captions (PC-08) ----
  socket.on("caption:upload", (data: { vttContent: string }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    room.subtitleVtt = String(data?.vttContent ?? "").slice(0, 2_000_000);
    io.to(room.roomId).emit("caption:update", { vttContent: room.subtitleVtt });
  });

  // ---- WebRTC signaling relay ----
  socket.on("rtc:offer", (data: { targetSocketId: string; sdp: unknown }) => {
    if (!ctx.roomId) return;
    io.to(String(data?.targetSocketId)).emit("rtc:offer", { fromSocketId: socket.id, sdp: data?.sdp });
  });
  socket.on("rtc:answer", (data: { targetSocketId: string; sdp: unknown }) => {
    if (!ctx.roomId) return;
    io.to(String(data?.targetSocketId)).emit("rtc:answer", { fromSocketId: socket.id, sdp: data?.sdp });
  });
  socket.on("rtc:ice", (data: { targetSocketId: string; candidate: unknown }) => {
    if (!ctx.roomId) return;
    io.to(String(data?.targetSocketId)).emit("rtc:ice", { fromSocketId: socket.id, candidate: data?.candidate });
  });

  // ---- Disconnect (RM-07/RM-08) ----
  // Diagnostics from a client's browser (see apps/web/src/lib/diag.ts): the
  // only easy window into an iPad's Safari without a Mac.
  socket.on("client:diag", (data: { msg: string }) => {
    const now = Date.now();
    ctx.diagTimes = ctx.diagTimes.filter((t) => now - t < 60_000);
    if (ctx.diagTimes.length >= 60) return;
    ctx.diagTimes.push(now);
    logLine(ctx.roomId, ctx.name, `[client] ${String(data?.msg ?? "").slice(0, 400)}`);
  });

  socket.on("disconnect", (reason: string) => {
    // "transport close" right after activity usually means the page died or was
    // closed; "ping timeout" means it went silent (suspended, network gone).
    if (ctx.roomId) logLine(ctx.roomId, ctx.name, `left (${reason})`);
    const room = currentRoom();
    ctxBySocket.delete(socket.id);
    if (!room) return;

    const user = room.users.get(socket.id);
    room.users.delete(socket.id);
    room.guestBufferStates.delete(socket.id);
    touch(room);

    if (user) {
      const sys = systemMessage(room, `${user.name} left`);
      io.to(room.roomId).emit("chat:message", sys);
      io.to(room.roomId).emit("room:leave", { user: { id: socket.id, name: user.name } });
      io.to(room.roomId).emit("room:users", { users: usersPayload(room) });
      io.to(room.roomId).emit("buffer:states", { states: bufferStatesPayload(room) });
    }

    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      // Pause authoritative state during the outage.
      const now = Date.now();
      const st = room.playbackState;
      const elapsed = st.playing ? ((now - st.updatedAt) / 1000) * st.speed : 0;
      room.playbackState = { ...st, playing: false, currentTime: st.currentTime + elapsed, updatedAt: now };

      // Guests follow the host: pause them too (the host re-asserts its real
      // state when it reconnects).
      io.to(room.roomId).emit("sync:pause", { timestamp: room.playbackState.currentTime, serverTime: now });
      io.to(room.roomId).emit("host:disconnected", { graceMs: HOST_GRACE_MS });
      room.hostGraceTimer = setTimeout(() => {
        room.hostGraceTimer = null;
        if (room.hostSocketId === null) {
          io.to(room.roomId).emit("host:gone");
        }
      }, HOST_GRACE_MS);
    }

    if (room.users.size === 0) {
      // Empty room is cleaned by the idle sweep; keep brief grace for reconnects.
      touch(room);
    }
  });
}
