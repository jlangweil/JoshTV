import * as MP4Box from "mp4box";
import type { ISOFile, MP4ArrayBuffer, MP4Info } from "mp4box";
import { ChunkStore, ByteRange, MediaStore } from "./ChunkStore";
import { OpfsStore, getStorageCaps } from "./OpfsStore";
import { isIOS } from "./platform";

export interface AssemblerCallbacks {
  /** Progressive MSE playback is ready (or src switched to the final blob). */
  onSourceChanged: (src: string, mode: "mse" | "blob") => void;
  onProgress: (receivedBytes: number, totalBytes: number) => void;
  onComplete: () => void;
  onError: (message: string) => void;
  /** Ask the host to send [start, end) next, replacing the current range. */
  requestRange: (start: number, end: number) => void;
  /** Diagnostic event line (sent to the server log). */
  log: (message: string) => void;
}

interface TrackBuffer {
  trackId: number;
  sourceBuffer: SourceBuffer;
  queue: ArrayBuffer[];
  /** mp4box keeps emitting segments after eviction; drop until next init. */
  failed: boolean;
}

type MediaSourceCtor = typeof MediaSource;

/**
 * Classic MSE where it exists (desktop, iPad); ManagedMediaSource otherwise
 * (iPhone, iOS 17.1+), which only opens when AirPlay is disabled on the video.
 */
function pickMediaSource(): { ctor: MediaSourceCtor; managed: boolean } | null {
  const w = window as unknown as { MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor };
  if (w.MediaSource) return { ctor: w.MediaSource, managed: false };
  if (w.ManagedMediaSource) return { ctor: w.ManagedMediaSource, managed: true };
  return null;
}

/** Bytes handed to mp4box per step. */
const FEED_STEP_BYTES = 1024 * 1024;
/** Keep MSE this many seconds ahead of the playhead — no further, to bound memory. */
const FEED_AHEAD_S = 30;
/** Trim MSE data this far behind the playhead. */
const KEEP_BEHIND_S = 30;
/** If the next byte playback needs is missing and this close to the feed position, fetch it now. */
const PRIORITY_BYTES = 16 * 1024 * 1024;
/** Without an index this far in, the file isn't "faststart": fall back to full download. */
const MAX_BYTES_BEFORE_INDEX = 32 * 1024 * 1024;
const SEEK_COOLDOWN_MS = 2000;
/** A target this close past what's been fed is reached by feeding, not seeking. */
const SEEK_SLACK_S = 8;
/** Headroom to leave when deciding whether the movie fits in disk storage. */
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;
/** On iOS without disk storage, bigger movies aren't kept whole (RAM would run out). */
const IOS_MAX_MEMORY_BYTES = 300 * 1024 * 1024;
/** "window" storage: keep this much media ahead of / behind the feed position. */
const WINDOW_AHEAD_S = 90;
const WINDOW_BEHIND_S = 30;
const WINDOW_MIN_AHEAD_BYTES = 32 * 1024 * 1024;

/**
 * Guest-side media pipeline (BF-09).
 *
 * Download and playback are decoupled:
 *  - Download: offset-addressed chunks from the host land in a ChunkStore
 *    (Blobs, off the JS heap). The host is steered to whatever playback
 *    needs next, then fills forward, then backfills from the start.
 *  - Playback: while the file arrives, a feeder hands stored bytes to
 *    mp4box.js (remux to fragmented MP4) and MSE, only ~30s ahead of the
 *    playhead, releasing what's been consumed. Memory stays roughly constant
 *    regardless of movie size — essential on iPad.
 *  - Once every byte is here, the player switches to a Blob URL of the whole
 *    file: native playback, freely seekable, immune to network hiccups.
 *
 * Late joins and far seeks: tick() gets the room's position; if MSE doesn't
 * have it and the feeder won't reach it soon, mp4box is re-pointed at that
 * time and the download is redirected to the matching byte offset.
 */
export class StreamAssembler {
  private store: MediaStore = new ChunkStore();
  private finishing = false;
  receivedBytes = 0;
  totalBytes = 0;
  complete = false;
  mode: "mse" | "blob-pending" | "blob" = "mse";
  /** Using ManagedMediaSource: the video element must have disableRemotePlayback. */
  managed = false;

  /** Range the host is currently sending, and how far into it we've got. */
  private job: ByteRange | null = null;
  private jobCursor = 0;
  private bytesPerSecond = 0;
  private rateWindow = { at: 0, bytes: 0 };

  private box: ISOFile | null = null;
  private mediaSource: MediaSource | null = null;
  private mediaSourceCtor: MediaSourceCtor | null = null;
  private mseUrl: string | null = null;
  private blobUrl: string | null = null;
  private tracks: TrackBuffer[] = [];
  private sourceOpen = false;
  private pendingInit: Array<{ id: number; buffer: ArrayBuffer }> | null = null;
  private info: MP4Info | null = null;
  private mseFailed = false;
  private disposed = false;

  /** Next byte to hand mp4box; it's fed sequentially from here, out of the store. */
  private feedCursor = 0;
  private feeding = false;
  /** Media time (s) reached by the segments produced so far; null right after a seek. */
  private segmentEnd: number | null = null;
  private lastSeekAt = -Infinity;

  // ---- Recovery when the browser breaks the video pipeline ----
  // iOS can tear down a backgrounded page's decoder ("Media failed to decode"),
  // which permanently closes its MediaSource. We then rebuild MSE from scratch,
  // which needs the file's header (ftyp+moov) again — streaming-only storage
  // may have evicted it, so the bytes fed before the index was parsed are kept.
  private headerBufs: MP4ArrayBuffer[] = [];
  private headerEnd = 0;
  private lastRoomTime: number | null = null;
  private restartPending: string | null = null;
  private restarts: number[] = [];
  private seekOnReady = false;

  constructor(
    /** Getter, not the element: the <video> may mount after the stream starts. */
    private getVideo: () => HTMLVideoElement | null,
    private cb: AssemblerCallbacks
  ) {}

  /** A requested range is still outstanding (silence from the host now means trouble). */
  get expectingData(): boolean {
    return !this.complete && this.job !== null && this.jobCursor < this.job.end;
  }

  /** How downloaded bytes are kept; "window" = streaming only, never assembled. */
  get storageKind(): MediaStore["kind"] {
    return this.store.kind;
  }

  start(totalBytes: number, fileId: string): void {
    this.totalBytes = totalBytes;
    const ms = pickMediaSource();
    this.store = this.chooseStore(totalBytes, fileId);
    this.cb.log(
      `stream start: ${(totalBytes / 1e6).toFixed(0)}MB, storage=${this.store.kind}, ` +
        `mse=${ms ? (ms.managed ? "managed" : "classic") : "none"}`
    );
    if (!ms && this.store.kind === "window") {
      // Can't stream progressively and can't keep the whole movie: nothing can play.
      // (Chrome/Firefox on iPad are WebKit web views without these features.)
      this.cb.onError("This browser can't play a movie this big — open the link in Safari, or use your own copy");
    }
    // The host starts every stream at byte 0.
    this.job = { start: 0, end: totalBytes };
    this.jobCursor = 0;
    this.rateWindow = { at: performance.now(), bytes: 0 };
    if (!ms) {
      this.mode = "blob-pending";
      return;
    }
    this.managed = ms.managed;
    this.mediaSourceCtor = ms.ctor;
    this.initMse();
  }

  /** Fresh mp4box + MediaSource. Callbacks from a replaced instance are ignored. */
  private initMse(): void {
    const MS = this.mediaSourceCtor;
    if (!MS) return;
    const box = MP4Box.createFile();
    this.box = box;
    box.onError = () => {
      if (this.box === box) this.failMse("mp4box parse error");
    };
    box.onReady = (info) => {
      if (this.box === box) this.handleReady(info);
    };
    box.onSegment = (id, _user, buffer, sampleNum) => {
      if (this.box === box) this.handleSegment(id, buffer, sampleNum);
    };
    const mediaSource = new MS();
    this.mediaSource = mediaSource;
    this.sourceOpen = false;
    this.mseUrl = URL.createObjectURL(mediaSource);
    mediaSource.addEventListener("sourceopen", () => {
      if (this.mediaSource !== mediaSource) return;
      this.sourceOpen = true;
      this.tryInitSourceBuffers();
    });
    this.cb.onSourceChanged(this.mseUrl, "mse");
  }

  /**
   * The video element's MSE pipeline is dead (decode error, MediaSource closed
   * under us): rebuild it and land back on the room's position. Waits until
   * the page is visible — iOS would just break it again in the background.
   */
  private restartMse(reason: string): void {
    if (this.disposed || this.complete || this.mseFailed || this.mode !== "mse" || !this.mediaSourceCtor) return;
    if (document.visibilityState !== "visible") {
      this.restartPending ??= reason;
      return;
    }
    const now = performance.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.restarts.length >= 4) {
      this.failMse(`${reason} (keeps happening)`);
      return;
    }
    this.restarts.push(now);
    const at = this.lastRoomTime !== null ? this.lastRoomTime.toFixed(0) : "?";
    this.cb.log(`video pipeline broke (${reason}): rebuilding at ${at}s`);
    this.releaseMse();
    this.info = null;
    this.segmentEnd = null;
    this.initMse();
    const box = this.box as ISOFile | null;
    if (!box) return;
    // Replay the header so mp4box knows the tracks; once the new SourceBuffers
    // exist, jump straight to the room's position (see tryInitSourceBuffers).
    this.seekOnReady = true;
    try {
      for (const buf of this.headerBufs) box.appendBuffer(buf);
    } catch {
      this.failMse("mp4box could not re-read the file header");
      return;
    }
    this.feedCursor = this.headerEnd;
  }

  /**
   * A new connection to the host for the same file (after iOS suspended the
   * page, a network drop, a reconnect): keep everything received so far and
   * point the fresh stream at what's still missing.
   */
  resume(): void {
    if (this.disposed || this.complete) return;
    // A fresh stream starts at byte 0. Full-download modes always send a
    // redirect right away; streaming-only may need nothing, so it must know
    // the host is sending in order to tell it to stop.
    this.job = this.store.kind === "window" ? { start: 0, end: this.totalBytes } : null;
    this.jobCursor = 0;
    this.rateWindow = { at: performance.now(), bytes: 0 };
    this.scheduleDownload();
  }

  private chooseStore(totalBytes: number, fileId: string): MediaStore {
    const caps = getStorageCaps();
    if (caps?.opfs && caps.freeBytes > totalBytes + DISK_MARGIN_BYTES) {
      return new OpfsStore(fileId, (message) => this.handleStoreFailure(message));
    }
    if (isIOS && totalBytes > IOS_MAX_MEMORY_BYTES) {
      this.cb.log(
        `no disk storage (opfs=${caps?.opfs ?? "unknown"}, free=${((caps?.freeBytes ?? 0) / 1e6).toFixed(0)}MB): streaming only`
      );
      return new ChunkStore("window");
    }
    return new ChunkStore("memory");
  }

  /** Disk writes failed (storage full?): carry on streaming-only rather than lose playback. */
  private handleStoreFailure(message: string): void {
    if (this.disposed || this.complete || this.store.kind !== "disk") return;
    this.cb.log(`${message} — switching to streaming only`);
    this.store.dispose();
    this.store = new ChunkStore("window");
    this.receivedBytes = 0;
    this.job = null;
    this.scheduleDownload();
  }

  /** Bytes of media per second of playback (for sizing the streaming window). */
  private mediaBytesPerSecond(): number {
    const duration = this.info && this.info.timescale > 0 ? this.info.duration / this.info.timescale : 0;
    return duration > 0 ? this.totalBytes / duration : 0;
  }

  push(offset: number, buffer: ArrayBuffer): void {
    if (this.disposed || this.complete) return;
    const end = offset + buffer.byteLength;
    // Advance the range cursor even for bytes we already have: chunks from an
    // abandoned range can fill part of a newly requested one, and the request
    // must still count as done when the host finishes it.
    if (this.job && offset >= this.job.start && end <= this.job.end) {
      this.jobCursor = Math.max(this.jobCursor, end);
    }
    const added = this.store.add(offset, buffer); // may take ownership of buffer
    if (added) {
      this.receivedBytes += added;
      this.trackRate(added);
      this.cb.onProgress(this.receivedBytes, this.totalBytes);
    }

    if (this.receivedBytes >= this.totalBytes && this.store.kind !== "window") {
      void this.finish();
      return;
    }
    if (this.job && this.jobCursor >= this.job.end) {
      this.job = null;
      this.scheduleDownload();
    }
    if (added && offset <= this.feedCursor && this.feedCursor < end) void this.pumpFeed();
  }

  /** Called every ~500ms with the room's current position (null if unknown). */
  tick(roomTime: number | null): void {
    if (this.disposed || this.complete) return;
    if (roomTime !== null) this.lastRoomTime = roomTime;
    if (this.mode === "mse" && !this.mseFailed) {
      const video = this.getVideo();
      const ours = video !== null && this.mseUrl !== null && video.currentSrc === this.mseUrl;
      if (this.restartPending && document.visibilityState === "visible") {
        const reason = this.restartPending;
        this.restartPending = null;
        this.restartMse(reason);
      } else if (ours && video.error) {
        this.restartMse(`video error ${video.error.code}: ${video.error.message || "no message"}`);
      } else if (ours && this.sourceOpen && this.mediaSource?.readyState === "closed") {
        this.restartMse("MediaSource closed");
      }
    }
    if (roomTime !== null) this.ensureSeek(roomTime);
    if (this.store.kind === "window") {
      const behind = Math.max(16 * 1024 * 1024, this.mediaBytesPerSecond() * WINDOW_BEHIND_S);
      this.receivedBytes -= this.store.evictBefore(this.feedCursor - behind);
    }
    this.scheduleDownload();
    this.trimBehindPlayhead();
    void this.pumpFeed();
  }

  // ---- Download scheduling ----

  private scheduleDownload(): void {
    if (this.complete || this.finishing) return;
    if (this.store.kind === "window") {
      // Streaming only: fetch what's missing just ahead of playback, nothing else.
      const ahead = Math.max(WINDOW_MIN_AHEAD_BYTES, this.mediaBytesPerSecond() * WINDOW_AHEAD_S);
      const windowEnd = Math.min(this.totalBytes, this.feedCursor + ahead);
      const gap = this.store.firstGap(this.feedCursor, windowEnd);
      if (!gap) {
        // Everything playback needs soon is here: make sure the host is idle.
        if (this.job) {
          this.job = null;
          this.cb.requestRange(0, 0);
        }
        return;
      }
      const heading =
        this.job !== null &&
        this.jobCursor <= gap.start &&
        gap.start < this.job.end &&
        gap.start - this.jobCursor < 4 * 1024 * 1024;
      if (!heading) this.requestRange(gap);
      return;
    }
    const need = this.store.firstGap(this.feedCursor, this.totalBytes);
    if (need && need.start - this.feedCursor < PRIORITY_BYTES) {
      // Playback needs these bytes soon: make sure the host is on its way there.
      const lookahead = Math.max(4 * 1024 * 1024, this.bytesPerSecond * 8);
      const heading =
        this.job !== null &&
        this.jobCursor <= need.start &&
        need.start < this.job.end &&
        need.start - this.jobCursor < lookahead;
      if (!heading) this.requestRange(need);
      return;
    }
    // Nothing urgent: continue forward from playback, then backfill from 0.
    if (!this.job) {
      const gap = this.store.firstGap(this.feedCursor, this.totalBytes) ?? this.store.firstGap(0, this.totalBytes);
      if (gap) this.requestRange(gap);
    }
  }

  private requestRange(range: ByteRange): void {
    this.job = range;
    this.jobCursor = range.start;
    this.cb.requestRange(range.start, range.end);
  }

  private trackRate(bytes: number): void {
    const now = performance.now();
    this.rateWindow.bytes += bytes;
    const dt = now - this.rateWindow.at;
    if (dt >= 500) {
      const rate = (this.rateWindow.bytes * 1000) / dt;
      this.bytesPerSecond = this.bytesPerSecond ? this.bytesPerSecond * 0.7 + rate * 0.3 : rate;
      this.rateWindow = { at: now, bytes: 0 };
    }
  }

  // ---- Feeding mp4box / MSE ----

  private async pumpFeed(): Promise<void> {
    if (this.feeding) return;
    this.feeding = true;
    try {
      while (this.box && !this.disposed && !this.complete && !this.finishing && !this.mseFailed) {
        // Index parsed but SourceBuffers not ready yet: hold off.
        if (this.info && this.tracks.length === 0) break;
        if (!this.info && this.feedCursor >= MAX_BYTES_BEFORE_INDEX) {
          this.failMse("This file's index is at the end (not \"faststart\")");
          break;
        }
        const playhead = this.getVideo()?.currentTime ?? 0;
        if (this.segmentEnd !== null && this.segmentEnd - playhead > FEED_AHEAD_S) break;
        if (this.tracks.some((t) => t.queue.length > 8)) break; // let MSE catch up
        const start = this.feedCursor;
        const end = Math.min(this.store.contiguousEnd(start), start + FEED_STEP_BYTES);
        if (end <= start) break; // waiting for the download
        const buf = await this.store.read(start, end);
        // A seek may have moved the cursor while we were reading.
        if (!buf || !this.box || this.feedCursor !== start) continue;
        const mp4buf = buf as MP4ArrayBuffer;
        mp4buf.fileStart = start;
        this.feedCursor = end;
        // Everything up to the parsed index is the header (needed to rebuild).
        if (!this.info && this.headerEnd === 0) this.headerBufs.push(mp4buf);
        this.box.appendBuffer(mp4buf);
      }
    } catch {
      this.failMse("mp4box append error");
    } finally {
      this.feeding = false;
    }
  }

  private handleSegment(trackId: number, buffer: ArrayBuffer, sampleNum: number): void {
    const tb = this.tracks.find((t) => t.trackId === trackId);
    if (tb && !tb.failed) {
      tb.queue.push(buffer);
      this.pump(tb);
    }
    if (!this.box) return;
    // Let mp4box drop the sample data it has now remuxed.
    try {
      this.box.releaseUsedSamples(trackId, sampleNum);
    } catch {
      // best effort
    }
    const primary = this.info?.videoTracks[0] ?? this.info?.audioTracks[0];
    if (primary?.id === trackId) {
      const last = this.box.getTrackById(trackId)?.samples?.[sampleNum - 1];
      if (last) this.segmentEnd = (last.cts + last.duration) / last.timescale;
    }
  }

  /** Re-point mp4box when the room is somewhere MSE doesn't have and feeding won't reach soon. */
  private ensureSeek(time: number): void {
    if (this.mseFailed || !this.box || !this.info || this.tracks.length === 0) return;
    const video = this.getVideo();
    if (video && isBuffered(video.buffered, time)) return;
    if (this.segmentEnd !== null && time >= this.segmentEnd - 1 && time - this.segmentEnd < SEEK_SLACK_S) return;
    const now = performance.now();
    if (now - this.lastSeekAt < SEEK_COOLDOWN_MS) return;
    let offset: number;
    try {
      offset = this.box.seek(time, true).offset;
    } catch {
      return;
    }
    this.lastSeekAt = now;
    this.segmentEnd = null;
    this.feedCursor = offset;
    this.cb.log(`jump to ${time.toFixed(0)}s (byte ${(offset / 1e6).toFixed(0)}MB, have ${this.store.contiguousEnd(offset) > offset ? "data" : "nothing"} there)`);
    this.scheduleDownload();
    void this.pumpFeed();
  }

  // ---- MSE plumbing ----

  private handleReady(info: MP4Info): void {
    this.info = info;
    if (!this.box) return;
    if (this.headerEnd === 0) this.headerEnd = this.feedCursor;
    // One video + one audio track only: MSE rejects text/chapter tracks and
    // browsers allow a single SourceBuffer per type, so extra tracks (subtitles,
    // commentary audio) would otherwise sink the whole progressive path.
    for (const track of [info.videoTracks[0], info.audioTracks[0]]) {
      if (track) this.box.setSegmentOptions(track.id, null, { nbSamples: 100 });
    }
    const initSegs = this.box.initializeSegmentation();
    this.pendingInit = initSegs.map((s) => ({ id: s.id, buffer: s.buffer }));
    this.tryInitSourceBuffers();
  }

  private tryInitSourceBuffers(): void {
    const MS = this.mediaSourceCtor;
    if (!this.sourceOpen || !this.pendingInit || !this.info || !this.mediaSource || !MS || !this.box) return;
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
        if (!MS.isTypeSupported(mime)) {
          this.failMse(`Unsupported codec: ${track.codec}`);
          return;
        }
        const sb = this.mediaSource.addSourceBuffer(mime);
        const tb: TrackBuffer = { trackId: init.id, sourceBuffer: sb, queue: [init.buffer], failed: false };
        sb.addEventListener("updateend", () => {
          this.pump(tb);
          void this.pumpFeed();
        });
        sb.addEventListener("error", () => {
          if (this.tracks.includes(tb)) this.restartMse("SourceBuffer error");
        });
        this.tracks.push(tb);
        this.pump(tb);
      }
      // Only now start producing segments: any emitted before the
      // SourceBuffers existed would have been dropped, leaving a hole.
      this.box.start();
      if (this.seekOnReady && this.lastRoomTime !== null) {
        this.seekOnReady = false;
        this.lastSeekAt = -Infinity;
        this.ensureSeek(this.lastRoomTime);
      }
      void this.pumpFeed();
    } catch (e) {
      this.failMse(`MSE init failed: ${String(e)}`);
    }
  }

  private pump(tb: TrackBuffer): void {
    if (this.disposed || this.mseFailed || tb.failed) return;
    if (tb.sourceBuffer.updating || tb.queue.length === 0) return;
    const next = tb.queue.shift()!;
    try {
      tb.sourceBuffer.appendBuffer(next);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "QuotaExceededError") {
        tb.queue.unshift(next);
        this.evictBehindPlayhead(tb);
      } else if (name === "InvalidStateError") {
        // The MediaSource was closed under us (decoder torn down): rebuild.
        this.restartMse(`append failed: ${String(e)}`);
      } else {
        this.failMse(`append failed: ${String(e)}`);
      }
    }
  }

  /** Keep MSE's memory bounded: drop what's well behind the playhead. */
  private trimBehindPlayhead(): void {
    const t = this.getVideo()?.currentTime ?? 0;
    const cutoff = t - KEEP_BEHIND_S;
    if (cutoff <= 1) return;
    for (const tb of this.tracks) {
      const b = tb.sourceBuffer;
      if (tb.failed || b.updating || b.buffered.length === 0 || b.buffered.start(0) >= cutoff - 10) continue;
      try {
        b.remove(0, cutoff);
      } catch {
        // retried next tick
      }
    }
  }

  private evictBehindPlayhead(tb: TrackBuffer): void {
    const cutoff = Math.max(0, (this.getVideo()?.currentTime ?? 0) - 10);
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
    this.cb.log(`progressive playback failed: ${message}`);
    this.mseFailed = true;
    this.tracks = [];
    this.releaseMse();
    if (this.complete && this.blobUrl) {
      this.cb.onSourceChanged(this.blobUrl, "blob");
    } else if (this.mode === "mse") {
      this.mode = "blob-pending";
      if (this.store.kind === "window") {
        // Streaming-only never assembles the file, so there's nothing to fall back on.
        this.cb.onError(`${message}. Reload the page, or use your own copy of the movie`);
      } else {
        // Wait for the full file, then play from blob.
        this.cb.onError(`${message} — waiting for full download`);
      }
    }
  }

  /** The progressive path is done with: free mp4box and MSE memory. */
  private releaseMse(): void {
    try {
      this.box?.stop();
    } catch {
      // best effort
    }
    this.box = null;
    for (const tb of this.tracks) tb.failed = true; // late updateend/error from old buffers
    this.tracks = [];
    this.pendingInit = null;
    this.mediaSource = null;
    this.sourceOpen = false;
    if (this.mseUrl) URL.revokeObjectURL(this.mseUrl);
    this.mseUrl = null;
  }

  private async finish(): Promise<void> {
    if (this.disposed || this.complete || this.finishing) return;
    this.finishing = true;
    const blob = await this.store.finalize(this.totalBytes, "video/mp4");
    if (this.disposed) return;
    if (!blob) {
      this.finishing = false;
      this.cb.log("finalize failed: staying on progressive playback");
      return;
    }
    this.complete = true;
    this.cb.log(`download complete: playing the whole file from ${this.store.kind}`);
    this.job = null;
    this.releaseMse();
    // Switch to native playback of the fully received file.
    this.blobUrl = URL.createObjectURL(blob);
    this.mode = "blob";
    this.cb.onSourceChanged(this.blobUrl, "blob");
    this.cb.onComplete();
  }

  dispose(): void {
    this.disposed = true;
    this.releaseMse();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.store.dispose();
  }
}

function isBuffered(ranges: TimeRanges, t: number): boolean {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= t + 0.1 && ranges.end(i) > t + 0.5) return true;
  }
  return false;
}
