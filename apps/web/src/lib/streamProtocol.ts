/**
 * Host <-> guest media protocol over an ordered, reliable RTCDataChannel.
 *
 * Control messages are JSON strings. Media is binary: every chunk carries its
 * file offset (8-byte header), so the guest can ask for any byte range — a
 * late joiner fetches the part of the movie the room is watching first and
 * backfills the rest, instead of downloading from byte 0.
 */
export const FILE_READ_CHUNK = 512 * 1024; // BF-08: read the MP4 in 512KB slices
export const WIRE_CHUNK = 64 * 1024; // stay under SCTP message-size limits
// Kept small so a range switch (late join, far seek) isn't stuck behind a
// deep queue of bytes from the old position.
export const HIGH_WATER_MARK = 1024 * 1024; // pause sending above this
export const LOW_WATER_MARK = 256 * 1024; // resume below this

const HEADER_BYTES = 8;

/** Host -> guest: the file being streamed. The host starts sending from byte 0. */
export interface MetaMessage {
  type: "meta";
  /** FileMeta.id of the file being streamed. */
  fileId: string;
  name: string;
  size: number;
}

export interface ResetMessage {
  type: "reset";
}

/** Guest -> host: send [start, end) next, abandoning the current range. An empty range pauses sending. */
export interface RangeMessage {
  type: "range";
  start: number;
  end: number;
}

export type ControlMessage = MetaMessage | ResetMessage | RangeMessage;

export function parseControl(raw: string): ControlMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (msg && (msg.type === "meta" || msg.type === "reset" || msg.type === "range")) {
      return msg as ControlMessage;
    }
  } catch {
    // not a control message
  }
  return null;
}

export function encodeChunk(offset: number, data: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(HEADER_BYTES + data.byteLength);
  new DataView(out.buffer).setFloat64(0, offset);
  out.set(new Uint8Array(data), HEADER_BYTES);
  return out.buffer;
}

export function decodeChunk(buf: ArrayBuffer): { offset: number; data: ArrayBuffer } {
  return { offset: new DataView(buf).getFloat64(0), data: buf.slice(HEADER_BYTES) };
}

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
