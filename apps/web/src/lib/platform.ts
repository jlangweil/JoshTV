/** iPhone/iPad, including iPadOS Safari, which reports itself as a Mac. */
export const isIOS: boolean =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/**
 * iOS/iPadOS ignores programmatic volume (it's always 1; hardware buttons
 * only), so a volume slider there would move without doing anything.
 */
export const canSetVolume: boolean = (() => {
  try {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch {
    return true;
  }
})();

interface WebkitVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitPresentationMode?: string;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitEnterFullscreen?: () => void;
}

/** Standard Picture-in-Picture, or Safari's presentation-mode API where that's missing. */
export async function togglePictureInPicture(video: HTMLVideoElement): Promise<void> {
  const v = video as WebkitVideo;
  if (document.pictureInPictureEnabled && typeof v.requestPictureInPicture === "function") {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } else if (v.webkitSupportsPresentationMode?.("picture-in-picture") && v.webkitSetPresentationMode) {
    v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
  }
}

/** iPhone Safari has no element fullscreen; only the native video player can go fullscreen. */
export function enterNativeVideoFullscreen(video: HTMLVideoElement | null): boolean {
  const v = video as WebkitVideo | null;
  if (!v?.webkitEnterFullscreen) return false;
  v.webkitEnterFullscreen();
  return true;
}
