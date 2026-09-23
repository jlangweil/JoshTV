import { ByteCoverage, ByteRange } from "./ByteCoverage";

export type { ByteRange } from "./ByteCoverage";

/**
 * Where a guest keeps the bytes it has received, addressed by file offset.
 *  - "disk":   the browser's origin-private file system (OpfsStore). The whole
 *              movie is kept, and the finished file plays straight from disk.
 *  - "memory": Blobs (ChunkStore). Fine where the browser pages big Blobs to
 *              disk (Chrome); WebKit keeps them in RAM.
 *  - "window": Blobs, but only a window around the playhead is kept; the
 *              movie is never assembled. Used on iOS when disk storage isn't
 *              available, since holding a whole movie in RAM gets Safari's
 *              tab killed.
 */
export interface MediaStore {
  readonly kind: "disk" | "memory" | "window";
  /** Stores [offset, offset+len); returns how many bytes were new. May take ownership of `buf`. */
  add(offset: number, buf: ArrayBuffer): number;
  contiguousEnd(pos: number): number;
  firstGap(from: number, total: number): ByteRange | null;
  /** Bytes [start, end), which must all be present. */
  read(start: number, end: number): Promise<ArrayBuffer | null>;
  /** The whole file once every byte of [0, total) is present (never, for "window"). */
  finalize(total: number, type: string): Promise<Blob | null>;
  /** "window" only: drops everything before `pos`; returns bytes dropped. */
  evictBefore(pos: number): number;
  dispose(): void;
}

/** Contiguous received bytes are batched in memory up to this size, then moved into a Blob. */
const FLUSH_BYTES = 4 * 1024 * 1024;

/**
 * Sparse, offset-addressed storage in Blobs. Received bytes leave the JS heap
 * as they arrive; stored ranges never overlap (duplicates are dropped).
 */
export class ChunkStore implements MediaStore {
  private coverage = new ByteCoverage();
  /** Sorted, non-overlapping flushed pieces. */
  private pieces: Array<{ start: number; end: number; blob: Blob }> = [];
  /** Contiguous bytes not yet flushed to a Blob. */
  private run: { start: number; end: number; bufs: ArrayBuffer[] } | null = null;

  constructor(readonly kind: "memory" | "window" = "memory") {}

  add(offset: number, buf: ArrayBuffer): number {
    const end = offset + buf.byteLength;
    const missing = this.coverage.missing(offset, end);
    for (const [s, e] of missing) {
      this.append(s, s === offset && e === end ? buf : buf.slice(s - offset, e - offset));
    }
    return this.coverage.add(offset, end);
  }

  contiguousEnd(pos: number): number {
    return this.coverage.contiguousEnd(pos);
  }

  firstGap(from: number, total: number): ByteRange | null {
    return this.coverage.firstGap(from, total);
  }

  async read(start: number, end: number): Promise<ArrayBuffer | null> {
    if (this.contiguousEnd(start) < end) return null;
    this.flush();
    const out = new Uint8Array(end - start);
    for (const p of this.pieces) {
      if (p.end <= start || p.start >= end) continue;
      const a = Math.max(start, p.start);
      const b = Math.min(end, p.end);
      out.set(new Uint8Array(await p.blob.slice(a - p.start, b - p.start).arrayBuffer()), a - start);
    }
    return out.buffer;
  }

  async finalize(total: number, type: string): Promise<Blob | null> {
    if (this.kind === "window" || this.contiguousEnd(0) < total) return null;
    this.flush();
    return new Blob(
      this.pieces.map((p) => p.blob),
      { type }
    );
  }

  evictBefore(pos: number): number {
    if (this.kind !== "window") return 0;
    this.flush();
    const keep = this.pieces.filter((p) => p.end > pos);
    let dropped = 0;
    for (const p of this.pieces) {
      if (p.end <= pos) dropped += this.coverage.remove(p.start, p.end);
    }
    this.pieces = keep;
    return dropped;
  }

  dispose(): void {
    this.pieces = [];
    this.run = null;
  }

  private append(start: number, buf: ArrayBuffer): void {
    if (this.run && this.run.end === start) {
      this.run.bufs.push(buf);
      this.run.end += buf.byteLength;
    } else {
      this.flush();
      this.run = { start, end: start + buf.byteLength, bufs: [buf] };
    }
    if (this.run.end - this.run.start >= FLUSH_BYTES) this.flush();
  }

  private flush(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    const piece = { start: run.start, end: run.end, blob: new Blob(run.bufs) };
    let i = this.pieces.length;
    while (i > 0 && this.pieces[i - 1].start > piece.start) i--;
    this.pieces.splice(i, 0, piece);
  }
}
