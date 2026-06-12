export interface PlaybackState {
  playing: boolean;
  /** Video position (seconds) at the moment the state was captured. */
  currentTime: number;
  /** Server epoch ms when the state was captured. */
  updatedAt: number;
  speed: number;
}

export interface ChatMessage {
  id: string;
  user: string;
  color: string;
  text: string;
  ts: number;
  system?: boolean;
}

export interface RoomUser {
  socketId: string;
  name: string;
  color: string;
  isHost: boolean;
}

export interface FileMeta {
  name: string;
  size: number;
  duration: number;
  width: number;
  height: number;
}

export interface GuestBufferState {
  aheadSeconds: number;
  ready: boolean;
  receivedBytes: number;
  complete: boolean;
}

export interface Room {
  roomId: string;
  hostToken: string;
  hostSocketId: string | null;
  password: string | null;
  users: Map<string, RoomUser>;
  playbackState: PlaybackState;
  guestBufferStates: Map<string, GuestBufferState>;
  chatHistory: ChatMessage[];
  subtitleVtt: string | null;
  fileMeta: FileMeta | null;
  autoPauseOnBufferLow: boolean;
  lastActivity: number;
  hostGraceTimer: NodeJS.Timeout | null;
}

export const MAX_GUESTS = 10;
export const CHAT_HISTORY_LIMIT = 200;
export const CHAT_HISTORY_ON_JOIN = 50;
export const HOST_GRACE_MS = 30_000;
export const ROOM_IDLE_EXPIRY_MS = 12 * 60 * 60 * 1000;
