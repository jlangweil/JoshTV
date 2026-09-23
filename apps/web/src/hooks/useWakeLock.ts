import { useEffect } from "react";

/**
 * Keeps the screen awake while `active` (the room is playing), so an iPad
 * doesn't dim and auto-lock mid-movie — locking would also suspend the page
 * and drop its connections. The lock is released whenever the page is
 * hidden, so it is re-acquired on return.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released)) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) next.release().catch(() => {});
        else lock = next;
      } catch {
        // refused (battery saver, unsupported context) — nothing to do
      }
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      lock?.release().catch(() => {});
    };
  }, [active]);
}
