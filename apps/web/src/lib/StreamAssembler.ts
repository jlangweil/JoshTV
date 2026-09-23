import * as MP4Box from "mp4box";
import type { ISOFile, MP4ArrayBuffer, MP4Info } from "mp4box";

export interface AssemblerCallbacks {
  /** Progressive MSE playback is ready (or src switched to the final blob). */
  onSourceChanged: (src: string, mode: "mse" | "blob") => void;
  onProgress: (receivedBytes: number, totalBytes: number) => void;
  onComplete: () => void;
  onError: (message: string) => void;
  /** Ask the host to send [start, end) next, replacing the current range. */
  requestRange: (start: number, end: number) => void;
}

interface ByteRange {
  start: number;
  end: number;
}

/** Never jump for less than this: the current stream is about to get there anyway. */
const MIN_JUMP_BYTES = 4 * 1024 * 1024;
/** Don't jump if the current range reaches the playhead within this many seconds. */
const JUMP_LOOKAHEAD_S = 8;
const JUMP_COOLDOWN_MS = 2000;
/** "Have the playhead" means at least this much data from its sync sample onward. */
const PLAYHEAD_PROBE_BYTES = 256 * 1024;

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
 *
 * Chunks are offset-addressed, so the download needn't be sequential: when
 * the room is playing somewhere this guest hasn't received (late join, host
 * seeked far ahead), ensurePosition() redirects the host to that byte offset
 * and mp4box to that time; the skipped bytes are backfilled afterwards.
 */
export class StreamAssembler {
  private chunks: Array<{ offset: number; buf: ArrayBuffer }> = [];
  /** Sorted, merged [start, end) ranges received so far. */
  private covered: Array<[number, number]> = [];
  /** Range the host is currently sending, and how far into it we've got. */
  private job: ByteRange | null = null;
  private jobCursor = 0;
  private lastJumpAt = -Infinity;
  private bytesPerSecond = 0;
  private rateWindow = { at: 0, bytes: 0 };
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
    // The host starts every stream at byte 0.
    this.job = { start: 0, end: totalBytes };
    this.jobCursor = 0;
    this.rateWindow = { at: performance.now(), bytes: 0 };
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

  push(offset: number, buffer: ArrayBuffer): void {
    if (this.disposed || this.complete) return;
    const end = offset + buffer.byteLength;
    const added = this.addCoverage(offset, end);
    if (added === 0) return; // duplicate (e.g. still in flight from an abandoned range)
    this.chunks.push({ offset, buf: buffer });
    this.receivedBytes += added;
    this.trackRate(added);
    if (this.job && offset >= this.job.start && end <= this.job.end) {
      this.jobCursor = Math.max(this.jobCursor, end);
    }
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
    } else if (this.job && this.jobCursor >= this.job.end) {
      // Range done: keep going forward from here, then backfill from the start.
      const from = this.job.end;
      this.job = null;
      this.requestGap(from);
    }
  }

  /**
   * Called periodically with the room's current position. If that part of
   * the file isn't here and the current range won't reach it soon, jump.
   */
  ensurePosition(time: number): void {
    if (this.disposed || this.complete || this.mseFailed || !this.box || !this.info) return;
    const target = this.offsetForTime(time);
    if (target === null) return;
    if (this.isCovered(target, Math.min(target + PLAYHEAD_PROBE_BYTES, this.totalBytes))) return;
    const now = performance.now();
    if (now - this.lastJumpAt < JUMP_COOLDOWN_MS) return;
    if (this.job && this.jobCursor <= target && target < this.job.end) {
      const lookahead = Math.max(MIN_JUMP_BYTES, this.bytesPerSecond * JUMP_LOOKAHEAD_S);
      if (target - this.jobCursor < lookahead) return;
    }
    // Point mp4box's segmenter at the sync sample before `time`, then fetch
    // from the first byte we don't have at/after the offset it needs.
    let seekOffset: number;
    try {
      seekOffset = this.box.seek(time, true).offset;
    } catch {
      return;
    }
    this.lastJumpAt = now;
    this.requestGap(Math.min(seekOffset, target));
  }

  private requestGap(from: number): void {
    const gap = this.firstGap(from) ?? this.firstGap(0);
    if (!gap) return;
    this.job = gap;
    this.jobCursor = gap.start;
    this.cb.requestRange(gap.start, gap.end);
  }

  /** First missing range at or after `from`, ending where received data resumes. */
  private firstGap(from: number): ByteRange | null {
    let pos = from;
    for (const [a, b] of this.covered) {
      if (b <= pos) continue;
      if (a > pos) return { start: pos, end: a };
      pos = b;
    }
    return pos < this.totalBytes ? { start: pos, end: this.totalBytes } : null;
  }

  private isCovered(start: number, end: number): boolean {
    return this.covered.some(([a, b]) => a <= start && b >= end);
  }

  /** Merges [start, end) into the covered set; returns how many bytes were new. */
  private addCoverage(start: number, end: number): number {
    let added = end - start;
    let s = start;
    let e = end;
    const out: Array<[number, number]> = [];
    for (const [a, b] of this.covered) {
      if (b < s || a > e) {
        out.push([a, b]);
        continue;
      }
      added -= Math.max(0, Math.min(b, end) - Math.max(a, start));
      s = Math.min(s, a);
      e = Math.max(e, b);
    }
    out.push([s, e]);
    out.sort((x, y) => x[0] - y[0]);
    this.covered = out;
    return added;
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

  /** Byte offset of the video sync sample at/before `time` (no mp4box state change). */
  private offsetForTime(time: number): number | null {
    const track = this.info?.videoTracks[0] ?? this.info?.audioTracks[0];
    const samples = track && this.box?.getTrackById(track.id)?.samples;
    if (!samples?.length) return null;
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].dts / samples[mid].timescale <= time) lo = mid;
      else hi = mid - 1;
    }
    while (lo > 0 && !samples[lo].is_sync) lo--;
    return samples[lo].offset;
  }

  private finish(): void {
    if (this.disposed || this.complete) return;
    // Stitch the (possibly out-of-order, overlapping) chunks into the file.
    const parts: ArrayBuffer[] = [];
    let pos = 0;
    for (const c of [...this.chunks].sort((x, y) => x.offset - y.offset)) {
      const end = c.offset + c.buf.byteLength;
      if (end <= pos) continue;
      if (c.offset > pos) return; // hole: can't happen when coverage says complete
      parts.push(c.offset < pos ? c.buf.slice(pos - c.offset) : c.buf);
      pos = end;
    }
    this.complete = true;
    this.job = null;
    try {
      this.box?.flush();
    } catch {
      // flushing a partially-parsed file can throw; the blob takes over anyway
    }
    // Switch to native playback of the fully received file.
    const blob = new Blob(parts, { type: "video/mp4" });
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
