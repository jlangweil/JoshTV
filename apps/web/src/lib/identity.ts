import { AVATAR_COLORS } from "../types";

export interface Identity {
  name: string;
  color: string;
}

const KEY = "synccine-identity";
const HOST_PREFIX = "synccine-host-";
/** Rooms expire after 12h idle; keep host tokens a little longer, then prune. */
const HOST_TOKEN_TTL_MS = 13 * 60 * 60 * 1000;

// Storage can throw (private windows, blocked site data); treat that as empty.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered this time — the app still works for this visit
  }
}

/** The name/color this browser used last time, so returning people skip the prompt. */
export function loadIdentity(): Identity | null {
  try {
    const raw = read(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.name === "string" && parsed.name.trim() && typeof parsed?.color === "string") {
      return { name: parsed.name, color: parsed.color };
    }
  } catch {
    // fall through
  }
  return null;
}

export function saveIdentity(identity: Identity): void {
  write(KEY, JSON.stringify(identity));
}

export function randomColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

export function hostTokenKey(roomId: string): string {
  return `${HOST_PREFIX}${roomId}`;
}

function pruneHostTokens(): void {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(HOST_PREFIX)) continue;
      const savedAt = Number(JSON.parse(localStorage.getItem(key) ?? "{}")?.savedAt);
      if (!(now - savedAt < HOST_TOKEN_TTL_MS)) localStorage.removeItem(key);
    }
  } catch {
    // best effort
  }
}

/**
 * Kept in localStorage (not per-tab) so the host stays the host when they
 * open their room in another tab or come back after closing the browser.
 */
export function saveHostToken(roomId: string, token: string): void {
  pruneHostTokens();
  write(hostTokenKey(roomId), JSON.stringify({ token, savedAt: Date.now() }));
}

export function loadHostToken(roomId: string): string | null {
  try {
    const raw = read(hostTokenKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && Date.now() - Number(parsed.savedAt) < HOST_TOKEN_TTL_MS) {
      return parsed.token;
    }
  } catch {
    // fall through
  }
  return null;
}
