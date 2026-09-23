import type { Socket } from "socket.io-client";

/**
 * Remote diagnostics: short event lines sent to the server, which prints them
 * in its console. Safari's dev tools on an iPad need a Mac, so this is the
 * practical way to see what a guest's browser is doing. Lines are also kept
 * in memory and on console.info.
 */
let socket: Socket | null = null;
const pending: string[] = [];
const MAX_PENDING = 30;

export function attachDiag(s: Socket): () => void {
  socket = s;
  const flush = () => {
    while (pending.length && socket?.connected) socket.emit("client:diag", { msg: pending.shift() });
  };
  s.on("connect", flush);
  flush();
  return () => {
    s.off("connect", flush);
    if (socket === s) socket = null;
  };
}

export function diag(msg: string): void {
  console.info(`[diag] ${msg}`);
  if (socket?.connected) socket.emit("client:diag", { msg });
  else if (pending.length < MAX_PENDING) pending.push(msg);
}

export function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(0)}MB`;
}

// ---- Crash breadcrumb ----
// A Safari tab that runs out of memory just dies: no events, no unload. Keep a
// small "what was I doing" record in localStorage; if the next page load finds
// it without the clean-exit mark, report it.

const CRUMB_KEY = "joshtv-breadcrumb";
/** Set on pagehide: the page is leaving normally, so stop overwriting the clean mark. */
let exiting = false;

export interface Breadcrumb {
  room: string;
  at: number;
  state: string;
  clean?: boolean;
}

export function leaveBreadcrumb(room: string, state: string): void {
  if (exiting) return;
  try {
    localStorage.setItem(CRUMB_KEY, JSON.stringify({ room, at: Date.now(), state } satisfies Breadcrumb));
  } catch {
    // storage unavailable
  }
}

export function markCleanExit(): void {
  exiting = true;
  try {
    const raw = localStorage.getItem(CRUMB_KEY);
    if (raw) localStorage.setItem(CRUMB_KEY, JSON.stringify({ ...JSON.parse(raw), clean: true }));
  } catch {
    // ignore
  }
}

/** A previous page that died without a clean exit in the last 15 minutes, if any. Consumes it. */
function takeCrashReport(): Breadcrumb | null {
  try {
    const raw = localStorage.getItem(CRUMB_KEY);
    localStorage.removeItem(CRUMB_KEY);
    if (!raw) return null;
    const crumb = JSON.parse(raw) as Breadcrumb;
    return !crumb.clean && Date.now() - crumb.at < 15 * 60 * 1000 ? crumb : null;
  } catch {
    return null;
  }
}

let startupCrash: Breadcrumb | null = takeCrashReport();

/** Read once at load (before this page's breadcrumbs overwrite it); returned only once. */
export function takeStartupCrashReport(): Breadcrumb | null {
  const crash = startupCrash;
  startupCrash = null;
  return crash;
}
