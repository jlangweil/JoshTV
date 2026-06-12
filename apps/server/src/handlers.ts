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

export function registerHandlers(io: Server, socket: Socket): void {
  const ctx: SocketCtx = { roomId: null, isHost: false, name: "", color: "", chatTimes: [] };
  ctxBySocket.set(socket.id, ctx);

  const currentRoom = (): Room | undefined =>
    ctx.roomId ? getRoom(ctx.roomId) : undefined;

  // ---- Clock sync (SP-11) ----
  socket.on("clock:ping", (data: { clientTime: number }) => {
    socket.emit("clock:response", {
      clientTime: data?.clientTime ?? 0,
      serverTime: Date.now(),
    });
  });

  // ---- Join ----
  socket.on(
    "room:join",
    (
      data: {
        roomId: string;
        name: string;
        color: string;
        isHost: boolean;
        hostToken?: string;
        password?: string;
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
        // Host (re)connecting — cancel the disconnect grace timer (RM-08).
        if (room.hostGraceTimer) {
          clearTimeout(room.hostGraceTimer);
          room.hostGraceTimer = null;
          io.to(room.roomId).emit("host:reconnected");
        }
        room.hostSocketId = socket.id;
      } else {
        if (room.password && data.password !== room.password) {
          return ack?.({ ok: false, error: "Wrong password" });
        }
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

      // Full state for the joiner (sync:state on join/reconnect).
      socket.emit("sync:state", {
        playbackState: room.playbackState,
        serverTime: Date.now(),
        fileMeta: room.fileMeta,
        autoPauseOnBufferLow: room.autoPauseOnBufferLow,
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

      if (!data.isHost && room.fileMeta && room.hostSocketId) {
        // Ask the host to open a WebRTC stream toward this guest.
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
  socket.on("host:file-meta", (data: { name: string; size: number; duration: number; width: number; height: number }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    const replacing = room.fileMeta !== null;
    room.fileMeta = {
      name: String(data?.name ?? "video.mp4").slice(0, 200),
      size: Number(data?.size) || 0,
      duration: Number(data?.duration) || 0,
      width: Number(data?.width) || 0,
      height: Number(data?.height) || 0,
    };
    room.playbackState = { playing: false, currentTime: 0, updatedAt: Date.now(), speed: 1 };
    room.guestBufferStates.clear();
    touch(room);
    io.to(room.roomId).emit("file:meta", { fileMeta: room.fileMeta, serverTime: Date.now() });
    const sys = systemMessage(
      room,
      replacing ? `Host changed the video: ${room.fileMeta.name}` : `Now playing: ${room.fileMeta.name}`
    );
    io.to(room.roomId).emit("chat:message", sys);
  });

  socket.on("host:auto-pause", (data: { enabled: boolean }) => {
    const room = currentRoom();
    if (!room || !requireHost(room, socket)) return;
    room.autoPauseOnBufferLow = Boolean(data?.enabled);
    io.to(room.roomId).emit("room:auto-pause", { enabled: room.autoPauseOnBufferLow });
  });

  // ---- Guest buffer reports (BF-02/BF-03) ----
  socket.on("guest:buffer", (data: { aheadSeconds: number; ready: boolean; receivedBytes: number; complete: boolean }) => {
    const room = currentRoom();
    if (!room || ctx.isHost) return;
    room.guestBufferStates.set(socket.id, {
      aheadSeconds: Number(data?.aheadSeconds) || 0,
      ready: Boolean(data?.ready),
      receivedBytes: Number(data?.receivedBytes) || 0,
      complete: Boolean(data?.complete),
    });
    io.to(room.roomId).emit("buffer:states", { states: bufferStatesPayload(room) });
  });

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
  socket.on("disconnect", () => {
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
