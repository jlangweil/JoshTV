import { AVATAR_COLORS } from "../types";

export interface Identity {
  name: string;
  color: string;
}

const KEY = "synccine-identity";

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.name === "string" && typeof parsed?.color === "string") {
      return { name: parsed.name, color: parsed.color };
    }
  } catch {
    // fall through
  }
  return null;
}

export function saveIdentity(identity: Identity): void {
  localStorage.setItem(KEY, JSON.stringify(identity));
}

export function randomColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

export function hostTokenKey(roomId: string): string {
  return `synccine-host-${roomId}`;
}

export function saveHostToken(roomId: string, token: string): void {
  sessionStorage.setItem(hostTokenKey(roomId), token);
}

export function loadHostToken(roomId: string): string | null {
  return sessionStorage.getItem(hostTokenKey(roomId));
}
