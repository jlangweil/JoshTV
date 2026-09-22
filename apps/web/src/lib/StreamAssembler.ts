import * as MP4Box from "mp4box";
import type { ISOFile, MP4ArrayBuffer, MP4Info } from "mp4box";

export interface AssemblerCallbacks {
  /** Progressive MSE playback is ready (or src switched to the final blob). */
  onSourceChanged: (src: string, mode: "mse" | "blob") => void;
  onProgress: (receivedBytes: number, totalBytes: number) => void;
  onComplete: () => void;
  onError: (message: string) => void;
}

interface TrackBuffer {
  trackId: number;
  sourceBuffer: SourceBuffer;
  queue: ArrayBuffer[];
  /** mp4box keeps emitting segments after eviction; drop until next init. */
  failed: boolean;
}

/**
 * Guest-side media pipeline (BF-09).
 *
 * Strategy: while the file streams in, remux to fragmented MP4 with mp4box.js
 * and feed MediaSource for fast startup. Every raw chunk is also retained so
 * that once the transfer completes the player can switch to a plain Blob URL
 * — native playback of the fully buffered file, immune to MSE quota limits
 * and freely seekable. This is what guarantees "no interruptions" once the
 * download finishes.
 */
export class StreamAssembler {
  private chunks: ArrayBuffer[] = [];
  receivedBytes = 0;
  totalBytes = 0;
  complete = false;
  mode: "mse" | "blob-pending" | "blob" = "mse";

  private box: ISOFile | null = null;
  private mediaSource: MediaSource | null = null;
  private mseUrl: string | null = null;
  private blobUrl: string | null = null;
  private tracks: TrackBuffer[] = [];
  private sourceOpen = false;
  private pendingInit: Array<{ id: number; buffer: ArrayBuffer }> | null = null;
  private info: MP4Info | null = null;
  private mseFailed = false;
  private disposed = false;

  constructor(
    /** Getter, not the element: the <video> may mount after the stream starts. */
    private getVideo: () => HTMLVideoElement | null,
    private cb: AssemblerCallbacks
  ) {}

  start(totalBytes: number): void {
    this.totalBytes = totalBytes;
    if (!("MediaSource" in window)) {
      this.mode = "blob-pending";
      return;
    }
    this.box = MP4Box.createFile();
    this.box.onError = () => this.failMse("mp4box parse error");
    this.box.onReady = (info) => this.handleReady(info);
    this.box.onSegment = (id, _user, buffer) => this.enqueueSegment(id, buffer);

    this.mediaSource = new MediaSource();
    this.mseUrl = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener("sourceopen", () => {
      this.sourceOpen = true;
      this.tryInitSourceBuffers();
    });
    this.cb.onSourceChanged(this.mseUrl, "mse");
  }

  push(buffer: ArrayBuffer): void {
    if (this.disposed) return;
    this.chunks.push(buffer);
    const offset = this.receivedBytes;
    this.receivedBytes += buffer.byteLength;
    this.cb.onProgress(this.receivedBytes, this.totalBytes);

    if (this.box && !this.mseFailed) {
      try {
        const mp4buf = buffer.slice(0) as MP4ArrayBuffer;
        mp4buf.fileStart = offset;
        this.box.appendBuffer(mp4buf);
      } catch {
        this.failMse("mp4box append error");
      }
    }

    if (this.totalBytes > 0 && this.receivedBytes >= this.totalBytes) {
      this.finish();
    }
  }

  eof(): void {
    if (!this.complete) this.finish();
  }

  private finish(): void {
    if (this.disposed || this.complete) return;
    this.complete = true;
    try {
      this.box?.flush();
    } catch {
      // flushing a partially-parsed file can throw; the blob takes over anyway
    }
    // Switch to native playback of the fully received file.
    const blob = new Blob(this.chunks, { type: "video/mp4" });
    this.blobUrl = URL.createObjectURL(blob);
    this.mode = "blob";
    this.cb.onSourceChanged(this.blobUrl, "blob");
    this.cb.onComplete();
  }

  private handleReady(info: MP4Info): void {
    this.info = info;
    if (!this.box) return;
    // One video + one audio track only: MSE rejects text/chapter tracks and
    // browsers allow a single SourceBuffer per type, so extra tracks (subtitles,
    // commentary audio) would otherwise sink the whole progressive path.
    for (const track of [info.videoTracks[0], info.audioTracks[0]]) {
      if (track) this.box.setSegmentOptions(track.id, null, { nbSamples: 100 });
    }
    const initSegs = this.box.initializeSegmentation();
    this.pendingInit = initSegs.map((s) => ({ id: s.id, buffer: s.buffer }));
    this.box.start();
    this.tryInitSourceBuffers();
  }

  private tryInitSourceBuffers(): void {
    if (!this.sourceOpen || !this.pendingInit || !this.info || !this.mediaSource) return;
    if (this.tracks.length > 0) return;

    try {
      if (this.info.timescale > 0) {
        this.mediaSource.duration = this.info.duration / this.info.timescale;
      }
      for (const init of this.pendingInit) {
        const track = this.info.tracks.find((t) => t.id === init.id);
        if (!track) continue;
        const container = track.type === "audio" ? "audio/mp4" : "video/mp4";
        const mime = `${container}; codecs="${track.codec}"`;
        if (!MediaSource.isTypeSupported(mime)) {
          this.failMse(`Unsupported codec: ${track.codec}`);
          return;
        }
        const sb = this.mediaSource.addSourceBuffer(mime);
        const tb: TrackBuffer = { trackId: init.id, sourceBuffer: sb, queue: [init.buffer], failed: false };
        sb.addEventListener("updateend", () => this.pump(tb));
        sb.addEventListener("error", () => this.failMse("SourceBuffer error"));
        this.tracks.push(tb);
        this.pump(tb);
      }
    } catch (e) {
      this.failMse(`MSE init failed: ${String(e)}`);
    }
  }

  private enqueueSegment(trackId: number, buffer: ArrayBuffer): void {
    const tb = this.tracks.find((t) => t.trackId === trackId);
    if (!tb || tb.failed) return;
    tb.queue.push(buffer);
    this.pump(tb);
  }

  private pump(tb: TrackBuffer): void {
    if (this.disposed || this.mseFailed || tb.failed) return;
    if (tb.sourceBuffer.updating || tb.queue.length === 0) return;
    const next = tb.queue.shift()!;
    try {
      tb.sourceBuffer.appendBuffer(next);
    } catch (e) {
      if ((e as DOMException)?.name === "QuotaExceededError") {
        // Evict everything more than 30s behind the playhead, then retry.
        tb.queue.unshift(next);
        this.evictBehindPlayhead(tb);
      } else {
        this.failMse(`append failed: ${String(e)}`);
      }
    }
  }

  private evictBehindPlayhead(tb: TrackBuffer): void {
    const cutoff = Math.max(0, (this.getVideo()?.currentTime ?? 0) - 30);
    if (cutoff <= 0.5) {
      // Nothing to evict — stall MSE; the blob path will rescue playback.
      tb.failed = true;
      return;
    }
    try {
      tb.sourceBuffer.remove(0, cutoff);
      // updateend fires when removal completes and re-pumps the queue.
    } catch {
      tb.failed = true;
    }
  }

  private failMse(message: string): void {
    if (this.mseFailed || this.disposed) return;
    this.mseFailed = true;
    this.tracks = [];
    if (this.complete && this.blobUrl) {
      this.cb.onSourceChanged(this.blobUrl, "blob");
    } else if (!("MediaSource" in window) || this.mode === "mse") {
      // Wait for the full file, then play from blob.
      this.mode = "blob-pending";
      this.cb.onError(`${message} — waiting for full download`);
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.box?.stop();
    } catch {
      // best effort
    }
    if (this.mseUrl) URL.revokeObjectURL(this.mseUrl);
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.chunks = [];
    this.tracks = [];
  }
}
