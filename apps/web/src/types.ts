export interface PlaybackState {
  playing: boolean;
  currentTime: number;
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
  id: string;
  name: string;
  color: string;
  isHost: boolean;
}

export interface FileMeta {
  /** Server-assigned per load; changes whenever the host replaces the video. */
  id: string;
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
  /** Guest is playing its own local copy instead of the host's stream. */
  local: boolean;
}

export interface Reaction {
  id: string;
  emoji: string;
  user: string;
}

export const REACTION_EMOJIS = ["\u{1F44F}", "\u{1F602}", "\u{1F631}", "\u{2764}\u{FE0F}", "\u{1F525}"];

export const AVATAR_COLORS = [
  "#FFB3BA", "#FFDFBA", "#FFFFBA", "#BAFFC9", "#BAE1FF", "#E2BAFF",
  "#FFC9DE", "#C9FFF4", "#D4BAFF", "#BAFFD9", "#FFE9BA", "#BAD7FF",
];

export const PLAYBACK_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
