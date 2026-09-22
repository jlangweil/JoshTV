/**
 * Host -> guest media protocol over an ordered, reliable RTCDataChannel.
 *
 * Control messages are JSON strings; media is raw ArrayBuffers sent strictly
 * in file order, so the receiver tracks position by accumulated byte count.
 */
export const FILE_READ_CHUNK = 512 * 1024; // BF-08: read the MP4 in 512KB slices
export const WIRE_CHUNK = 64 * 1024; // stay under SCTP message-size limits
export const HIGH_WATER_MARK = 4 * 1024 * 1024; // pause sending above this
export const LOW_WATER_MARK = 1 * 1024 * 1024; // resume below this

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

export interface EofMessage {
  type: "eof";
}

export type ControlMessage = MetaMessage | ResetMessage | EofMessage;

export function parseControl(raw: string): ControlMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (msg && (msg.type === "meta" || msg.type === "reset" || msg.type === "eof")) {
      return msg as ControlMessage;
    }
  } catch {
    // not a control message
  }
  return null;
}

export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};
