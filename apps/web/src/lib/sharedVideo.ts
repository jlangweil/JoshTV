/**
 * The app's single <video> element, created up front and reused by every
 * player. Safari (and Chrome on iOS, same engine) grants sound per element:
 * an element may only start playing unmuted if play() was once called on it
 * during a tap. The movie's video element normally doesn't exist yet when the
 * viewer taps "Join room", and later playback starts from timers, so Safari
 * would force it muted. Owning the element from the start lets that first tap
 * unlock it (play() works for this even before any video is loaded).
 */
let element: HTMLVideoElement | null = null;
let unlocked = false;

export function getPlayerElement(): HTMLVideoElement {
  if (!element) {
    element = document.createElement("video");
    element.playsInline = true;
    element.setAttribute("playsinline", ""); // older iOS reads the attribute
    element.preload = "auto";
  }
  return element;
}

/** Call from inside a tap/click/key handler. Harmless if repeated or if nothing is loaded. */
export function unlockMedia(): void {
  if (unlocked) return;
  const v = getPlayerElement();
  // Only while idle: calling play() on a loaded video would actually start it.
  if (v.currentSrc) return;
  v.muted = false;
  v.play().catch(() => {
    // Rejects for lack of a source; the permission is granted regardless.
  });
  unlocked = true;
}

/** Whether a tap has already unlocked sound (e.g. the viewer came in via the Home page). */
export function isMediaUnlocked(): boolean {
  return unlocked;
}

/** Unlock on the first interaction anywhere in the app (capture phase, so still inside the gesture). */
export function installMediaUnlock(): void {
  const events = ["touchend", "pointerup", "click", "keydown"];
  const handler = () => {
    unlockMedia();
    if (unlocked) for (const t of events) window.removeEventListener(t, handler, true);
  };
  for (const t of events) window.addEventListener(t, handler, true);
}
