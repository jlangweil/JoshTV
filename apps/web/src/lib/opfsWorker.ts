// Dedicated worker owning one file in the origin-private file system (OPFS).
// Sync access handles (Safari 15.2+, Chrome 102+) only exist in workers.
// Messages are handled strictly in order, so a read always sees earlier writes.

interface SyncAccessHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
interface FileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
  getFile(): Promise<File>;
}
interface DirHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

type Msg =
  | { type: "probe" }
  | { type: "open"; name: string }
  | { type: "write"; offset: number; buf: ArrayBuffer }
  | { type: "read"; id: number; start: number; end: number }
  | { type: "finish"; id: number }
  | { type: "close" };

const ctx = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
  close(): void;
};

const PREFIX = "joshtv-";
let dir: DirHandle | null = null;
let file: FileHandle | null = null;
let access: SyncAccessHandle | null = null;
let fileName = "";
let failed = false;
let queue: Promise<void> = Promise.resolve();
let releaseLock: (() => void) | null = null;

interface LockManager {
  request(name: string, cb: () => Promise<void>): Promise<void>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
}
const locks = (navigator as unknown as { locks?: LockManager }).locks;
const lockName = (file: string) => `joshtv-file:${file}`;

async function root(): Promise<DirHandle> {
  dir ??= (await navigator.storage.getDirectory()) as unknown as DirHandle;
  return dir;
}

/**
 * Leftovers from earlier sessions (tab crashed, closed mid-download). A file
 * another tab is using holds a Web Lock and is skipped; without Web Locks we
 * can't tell, so nothing is removed.
 */
async function removeStale(keep: string): Promise<void> {
  if (!locks) return;
  const held = new Set(((await locks.query()).held ?? []).map((l) => l.name));
  const d = await root();
  const names: string[] = [];
  for await (const n of d.keys()) {
    if (n.startsWith(PREFIX) && n !== keep && !held.has(lockName(n))) names.push(n);
  }
  for (const n of names) await d.removeEntry(n).catch(() => {});
}

async function handle(m: Msg): Promise<void> {
  switch (m.type) {
    case "probe": {
      const probeName = `${PREFIX}probe-${Math.random().toString(36).slice(2)}`;
      const d = await root();
      const h = await (await d.getFileHandle(probeName, { create: true })).createSyncAccessHandle();
      h.close();
      await d.removeEntry(probeName);
      await removeStale("").catch(() => {});
      ctx.postMessage({ type: "probe", ok: true });
      return;
    }
    case "open": {
      fileName = m.name;
      // Held until "close", so other tabs' cleanup leaves this file alone.
      locks?.request(lockName(fileName), () => new Promise<void>((resolve) => (releaseLock = resolve))).catch(() => {});
      await removeStale(fileName).catch(() => {});
      file = await (await root()).getFileHandle(fileName, { create: true });
      access = await file.createSyncAccessHandle();
      access.truncate(0);
      return;
    }
    case "write": {
      if (failed || !access) return;
      access.write(new Uint8Array(m.buf), { at: m.offset });
      return;
    }
    case "read": {
      if (!access) throw new Error("file not open");
      const out = new Uint8Array(m.end - m.start);
      const n = access.read(out, { at: m.start });
      ctx.postMessage({ type: "read", id: m.id, buf: n === out.byteLength ? out.buffer : null }, [out.buffer]);
      return;
    }
    case "finish": {
      if (!access || !file) throw new Error("file not open");
      access.flush();
      access.close();
      access = null;
      // A disk-backed File: the player streams it from storage, not RAM.
      ctx.postMessage({ type: "file", id: m.id, file: await file.getFile() });
      return;
    }
    case "close": {
      access?.close();
      access = null;
      if (fileName) await (await root()).removeEntry(fileName).catch(() => {});
      releaseLock?.();
      ctx.close();
      return;
    }
  }
}

ctx.onmessage = (e) => {
  const m = e.data;
  queue = queue
    .then(() => handle(m))
    .catch((err) => {
      if (m.type === "probe") {
        ctx.postMessage({ type: "probe", ok: false, error: String(err) });
        return;
      }
      failed = true;
      ctx.postMessage({ type: "error", error: String(err), during: m.type });
      if ("id" in m) ctx.postMessage({ type: m.type === "finish" ? "file" : "read", id: m.id, buf: null, file: null });
    });
};
