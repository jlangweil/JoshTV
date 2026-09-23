import { randomBytes, randomUUID } from "node:crypto";
import {
  Room,
  ChatMessage,
  CHAT_HISTORY_LIMIT,
  ROOM_IDLE_EXPIRY_MS,
} from "./types.js";

const rooms = new Map<string, Room>();

// Unambiguous alphanumerics (no 0/O, 1/I/L) for readable room codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateRoomCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

export function createRoom(): Room {
  let roomId = generateRoomCode();
  while (rooms.has(roomId)) roomId = generateRoomCode();

  const room: Room = {
    roomId,
    hostToken: randomUUID(),
    hostSocketId: null,
    users: new Map(),
    playbackState: { playing: false, currentTime: 0, updatedAt: Date.now(), speed: 1 },
    guestBufferStates: new Map(),
    chatHistory: [],
    subtitleVtt: null,
    fileMeta: null,
    streamToGuests: true,
    lastActivity: Date.now(),
    hostGraceTimer: null,
  };
  rooms.set(roomId, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId.toUpperCase());
}

export function deleteRoom(roomId: string): void {
  const room = rooms.get(roomId);
  if (room?.hostGraceTimer) clearTimeout(room.hostGraceTimer);
  rooms.delete(roomId);
}

export function touch(room: Room): void {
  room.lastActivity = Date.now();
}

export function pushChat(room: Room, msg: ChatMessage): void {
  room.chatHistory.push(msg);
  if (room.chatHistory.length > CHAT_HISTORY_LIMIT) {
    room.chatHistory.splice(0, room.chatHistory.length - CHAT_HISTORY_LIMIT);
  }
  touch(room);
}

export function systemMessage(room: Room, text: string): ChatMessage {
  const msg: ChatMessage = {
    id: randomUUID(),
    user: "system",
    color: "#6B6B7B",
    text,
    ts: Date.now(),
    system: true,
  };
  pushChat(room, msg);
  return msg;
}

/** RM-02: expire rooms after 12h of inactivity or when everyone is gone. */
export function sweepIdleRooms(): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, room] of rooms) {
    const idle = now - room.lastActivity > ROOM_IDLE_EXPIRY_MS;
    const empty = room.users.size === 0 && now - room.lastActivity > 60_000;
    if (idle || empty) {
      expired.push(id);
      deleteRoom(id);
    }
  }
  return expired;
}

export function roomCount(): number {
  return rooms.size;
}
