import type { Socket } from "socket.io-client";

/**
 * The part of RTCDataChannel the stream code uses, so the server relay can
 * stand in for a direct connection without touching the protocol.
 */
export interface StreamChannel {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onmessage: ((ev: MessageEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
  addEventListener(type: "bufferedamountlow" | "close", listener: () => void): void;
  removeEventListener(type: "bufferedamountlow" | "close", listener: () => void): void;
}

/** A guest acknowledges relayed bytes at least this often (must stay below the host's low-water mark). */
export const RELAY_ACK_BYTES = 128 * 1024;

/**
 * Host end of a relayed stream to one guest: chunks go host → server → guest
 * over the sockets. bufferedAmount is bytes sent but not yet acknowledged by
 * the guest, so the host's normal backpressure bounds what's in flight (and
 * what the server holds) exactly as with a data channel.
 */
export class HostRelayChannel extends EventTarget implements StreamChannel {
  readyState: RTCDataChannelState = "open";
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private sent = 0;
  private acked = 0;

  constructor(
    private socket: Socket,
    private guestId: string
  ) {
    super();
  }

  get bufferedAmount(): number {
    return this.sent - this.acked;
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== "open") return;
    if (typeof data !== "string") this.sent += data.byteLength;
    this.socket.emit("relay:to-guest", { guestId: this.guestId, data });
  }

  /** A control message from the guest (e.g. a range request). */
  deliver(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  /** The guest has received `bytes` in total. */
  ack(bytes: number): void {
    const before = this.bufferedAmount;
    this.acked = Math.max(this.acked, Math.min(bytes, this.sent));
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

/** Guest end of a relayed stream: sends control messages (range requests) back to the host. */
export class GuestRelayChannel implements StreamChannel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private received = 0;
  private lastAck = 0;

  constructor(private socket: Socket) {}

  send(data: string | ArrayBuffer): void {
    if (this.readyState === "open" && typeof data === "string") this.socket.emit("relay:to-host", { data });
  }

  /** Count relayed bytes and acknowledge them so the host keeps sending. */
  countReceived(bytes: number): void {
    this.received += bytes;
    if (this.received - this.lastAck >= RELAY_ACK_BYTES) {
      this.lastAck = this.received;
      this.socket.emit("relay:ack", { bytes: this.received });
    }
  }

  close(): void {
    this.readyState = "closed";
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}
