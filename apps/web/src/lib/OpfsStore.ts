import { ByteCoverage, ByteRange } from "./ByteCoverage";
import type { MediaStore } from "./ChunkStore";

function spawnWorker(): Worker {
  return new Worker(new URL("./opfsWorker.ts", import.meta.url), { type: "module" });
}

/**
 * Disk-backed MediaStore: bytes go straight to a file in the browser's
 * origin-private file system via a worker, so a multi-GB movie never sits in
 * RAM. On iPad this is what keeps Safari from killing the tab (WebKit holds
 * Blob data in memory). The finished file plays directly from disk.
 */
export class OpfsStore implements MediaStore {
  readonly kind = "disk" as const;
  private coverage = new ByteCoverage();
  private worker = spawnWorker();
  private waiting = new Map<number, (value: { buf?: ArrayBuffer | null; file?: File | null }) => void>();
  private nextId = 1;
  private disposed = false;

  constructor(
    fileId: string,
    /** Writing failed (e.g. storage full): data from here on is lost. */
    private onFailure: (message: string) => void
  ) {
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "error") {
        this.onFailure(`disk storage failed during ${m.during}: ${m.error}`);
        return;
      }
      const resolve = this.waiting.get(m.id);
      if (resolve) {
        this.waiting.delete(m.id);
        resolve(m);
      }
    };
    this.worker.onerror = (e) => this.onFailure(`storage worker error: ${e.message}`);
    this.worker.postMessage({ type: "open", name: `joshtv-${fileId.replace(/[^a-z0-9-]/gi, "")}` });
  }

  add(offset: number, buf: ArrayBuffer): number {
    const added = this.coverage.add(offset, offset + buf.byteLength);
    // Overlapping bytes are identical, so just (re)write the whole chunk.
    if (added) this.worker.postMessage({ type: "write", offset, buf }, [buf]);
    return added;
  }

  contiguousEnd(pos: number): number {
    return this.coverage.contiguousEnd(pos);
  }

  firstGap(from: number, total: number): ByteRange | null {
    return this.coverage.firstGap(from, total);
  }

  async read(start: number, end: number): Promise<ArrayBuffer | null> {
    if (this.disposed || this.contiguousEnd(start) < end) return null;
    const { buf } = await this.request({ type: "read", start, end });
    return buf ?? null;
  }

  async finalize(total: number, type: string): Promise<Blob | null> {
    if (this.disposed || this.contiguousEnd(0) < total) return null;
    const { file } = await this.request({ type: "finish" });
    return file ? new Blob([file], { type }) : null;
  }

  evictBefore(): number {
    return 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // The worker deletes the file and exits.
    this.worker.postMessage({ type: "close" });
    for (const resolve of this.waiting.values()) resolve({ buf: null, file: null });
    this.waiting.clear();
  }

  private request(msg: { type: "read"; start: number; end: number } | { type: "finish" }) {
    const id = this.nextId++;
    return new Promise<{ buf?: ArrayBuffer | null; file?: File | null }>((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ ...msg, id });
    });
  }
}

export interface StorageCaps {
  opfs: boolean;
  /** Bytes the origin may still store, per navigator.storage.estimate(). */
  freeBytes: number;
}

let caps: StorageCaps | null = null;

/** Probe once at startup: can this browser write files to OPFS, and how much room is there? */
export const storageCapsReady: Promise<StorageCaps> = (async () => {
  let opfs = false;
  try {
    if (typeof Worker !== "undefined" && typeof navigator.storage?.getDirectory === "function") {
      const w = spawnWorker();
      opfs = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        w.onmessage = (e) => {
          clearTimeout(timer);
          resolve(Boolean(e.data?.ok));
        };
        w.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
        w.postMessage({ type: "probe" });
      });
      w.terminate();
    }
  } catch {
    opfs = false;
  }
  let freeBytes = 0;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) freeBytes = Math.max(0, est.quota - (est.usage ?? 0));
  } catch {
    // unknown
  }
  caps = { opfs, freeBytes };
  return caps;
})();

/** The probe's result if it has finished, else null (treated as "no disk storage"). */
export function getStorageCaps(): StorageCaps | null {
  return caps;
}
