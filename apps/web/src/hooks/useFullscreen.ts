import { useCallback, useEffect, useState, RefObject } from "react";
import { enterNativeVideoFullscreen } from "../lib/platform";

interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

interface FullscreenDocument extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

/**
 * FS-01: fullscreen on the container div (so chat stays reachable), with the
 * webkit-prefixed API for older iPadOS. iPhone Safari has no element
 * fullscreen at all, so there it falls back to the native video player.
 */
export function useFullscreen(ref: RefObject<HTMLElement>, videoRef?: RefObject<HTMLVideoElement>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const doc = document as FullscreenDocument;
    const onChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement ?? doc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggle = useCallback(async () => {
    const el = ref.current as FullscreenElement | null;
    const doc = document as FullscreenDocument;
    if (!el) return;
    try {
      if (document.fullscreenElement ?? doc.webkitFullscreenElement) {
        await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.());
      } else if (el.requestFullscreen || el.webkitRequestFullscreen) {
        await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
      } else {
        enterNativeVideoFullscreen(videoRef?.current ?? null);
      }
    } catch {
      // Fullscreen can be rejected (e.g., not user-initiated) — ignore.
    }
  }, [ref, videoRef]);

  return { isFullscreen, toggle };
}
