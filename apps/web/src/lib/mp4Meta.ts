import * as MP4Box from "mp4box";
import type { MP4ArrayBuffer } from "mp4box";

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

/**
 * Host-side: extract duration/resolution by feeding the file to mp4box until
 * the moov box is parsed. Reads from the front; if moov lives at the end
 * (non-faststart files), falls back to a temporary <video> element probe.
 */
export async function probeVideoMeta(file: File): Promise<VideoMeta> {
  const fromBox = await probeWithMp4box(file).catch(() => null);
  if (fromBox) return fromBox;
  return probeWithVideoElement(file);
}

async function probeWithMp4box(file: File): Promise<VideoMeta | null> {
  const box = MP4Box.createFile();
  let resolved: VideoMeta | null = null;

  return new Promise<VideoMeta | null>((resolve, reject) => {
    box.onError = (e) => reject(new Error(e));
    box.onReady = (info) => {
      const v = info.videoTracks[0];
      resolved = {
        duration: info.timescale > 0 ? info.duration / info.timescale : 0,
        width: v?.video?.width ?? 0,
        height: v?.video?.height ?? 0,
      };
      resolve(resolved);
    };

    (async () => {
      const CHUNK = 1024 * 1024;
      // moov is usually near the front for faststart files; cap the scan.
      const maxScan = Math.min(file.size, 64 * CHUNK);
      let offset = 0;
      while (offset < maxScan && !resolved) {
        const buf = (await file
          .slice(offset, offset + CHUNK)
          .arrayBuffer()) as MP4ArrayBuffer;
        buf.fileStart = offset;
        box.appendBuffer(buf);
        offset += CHUNK;
      }
      if (!resolved) resolve(null);
    })().catch(reject);
  });
}

function probeWithVideoElement(file: File): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const meta = {
        duration: video.duration || 0,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read video metadata"));
    };
    video.src = url;
  });
}
