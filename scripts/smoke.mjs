// End-to-end smoke test against a running server (node scripts/smoke.mjs).
// Exercises: room creation, host+guest join, clock sync, playback sync
// broadcast, chat relay, buffer reports, and RTC signaling relay.
import { io } from "socket.io-client";

const BASE = process.env.BASE_URL ?? "http://localhost:3001";
let failures = 0;

function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

const res = await fetch(`${BASE}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
const { roomId, hostToken } = await res.json();
check("POST /api/rooms returns 6-char code", typeof roomId === "string" && roomId.length === 6);
check("POST /api/rooms returns hostToken", typeof hostToken === "string" && hostToken.length > 10);

const info = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
check("GET /api/rooms/:id", info.exists === true && info.maxGuests === 10);

const host = io(BASE, { transports: ["websocket"] });
const guest = io(BASE, { transports: ["websocket"] });

await Promise.all([once(host, "connect"), once(guest, "connect")]);

// Clock sync
const t0 = Date.now();
host.emit("clock:ping", { clientTime: t0 });
const clock = await once(host, "clock:response");
check("clock:response echoes clientTime + serverTime", clock.clientTime === t0 && typeof clock.serverTime === "number");

// Host join
// Listen before joining: sync:state follows the ack immediately and can
// arrive in the same frame, before a listener attached after the ack.
const hostStatePromise = once(host, "sync:state");
const hostAck = await new Promise((resolve) =>
  host.emit("room:join", { roomId, name: "Host", color: "#FFB3BA", isHost: true, hostToken }, resolve)
);
check("host join ok", hostAck.ok === true);
await hostStatePromise;

// Bad host token rejected
const badAck = await new Promise((resolve) =>
  io(BASE, { transports: ["websocket"] })
    .on("connect", function () {
      this.emit("room:join", { roomId, name: "Evil", color: "#fff", isHost: true, hostToken: "nope" }, (r) => {
        this.disconnect();
        resolve(r);
      });
    })
);
check("bad host token rejected", badAck.ok === false);

// Guest join → receives state + history
const guestStatePromise = once(guest, "sync:state");
const guestAck = await new Promise((resolve) =>
  guest.emit("room:join", { roomId, name: "Guest", color: "#BAE1FF", isHost: false }, resolve)
);
check("guest join ok", guestAck.ok === true);
const guestState = await guestStatePromise;
check("guest receives sync:state", guestState.playbackState?.playing === false);

// Host file meta → guest gets file:meta and host gets stream:request when guest joins later
const fileAckPromise = new Promise((resolve) =>
  host.emit("host:file-meta", { name: "movie.mp4", size: 1000, duration: 120, width: 1920, height: 1080 }, resolve)
);
const fm = await once(guest, "file:meta");
check("guest receives file:meta", fm.fileMeta?.name === "movie.mp4");
const fileAck = await fileAckPromise;
check("host:file-meta acks the file id", typeof fileAck.id === "string" && fileAck.id === fm.fileMeta.id);
const fileId = fileAck.id;

// Late guest triggers stream:request to host
const late = io(BASE, { transports: ["websocket"] });
await once(late, "connect");
const streamReqPromise = once(host, "stream:request");
late.emit("room:join", { roomId, name: "Late", color: "#E2BAFF", isHost: false }, () => {});
const streamReq = await streamReqPromise;
check("host receives stream:request for late guest", typeof streamReq.guestSocketId === "string");

// Playback sync
const playPromise = once(guest, "sync:play");
host.emit("host:play", { timestamp: 42.5 });
const play = await playPromise;
check("sync:play broadcast with timestamp + serverTime", play.timestamp === 42.5 && typeof play.serverTime === "number");

// Guest cannot drive playback
guest.emit("host:pause", { timestamp: 0 });
let leaked = false;
guest.once("sync:pause", () => (leaked = true));
await new Promise((r) => setTimeout(r, 300));
check("guest host:pause ignored", leaked === false);

// Chat
const chatPromise = once(guest, "chat:message", 3000);
host.emit("chat:send", { text: "hello @Guest" });
// skip system messages until the real one arrives
let chatMsg = await chatPromise;
while (chatMsg.system) chatMsg = await once(guest, "chat:message");
check("chat relayed", chatMsg.text === "hello @Guest" && chatMsg.user === "Host");

// Chat rate limit: 6 rapid messages → only 3 delivered
let received = 0;
const counter = (m) => {
  if (!m.system && m.user === "Guest") received++;
};
host.on("chat:message", counter);
for (let i = 0; i < 6; i++) guest.emit("chat:send", { text: `spam ${i}` });
await new Promise((r) => setTimeout(r, 600));
host.off("chat:message", counter);
check("chat rate limited to 3/sec", received === 3);

// Buffer reports reach host
let staleRelayed = false;
const staleWatch = () => (staleRelayed = true);
host.on("buffer:states", staleWatch);
guest.emit("guest:buffer", { fileId: "old-file", aheadSeconds: 99, ready: true, receivedBytes: 1000, complete: true });
await new Promise((r) => setTimeout(r, 300));
host.off("buffer:states", staleWatch);
check("buffer report for a replaced file ignored", staleRelayed === false);

const bufPromise = once(host, "buffer:states");
guest.emit("guest:buffer", { fileId, aheadSeconds: 2.5, ready: false, receivedBytes: 100, complete: false, local: false });
const buf = await bufPromise;
const states = Object.values(buf.states);
check("buffer:states relayed", states.some((s) => s.aheadSeconds === 2.5));

// Guest with a local copy reports complete; a reconnect holding the file skips streaming.
const localBufPromise = once(host, "buffer:states");
late.emit("guest:buffer", { fileId, aheadSeconds: 99999, ready: true, receivedBytes: 1000, complete: true, local: true });
const localBuf = await localBufPromise;
check("local-copy flag relayed", localBuf.states[late.id]?.local === true);

async function joinGuest(name, extra = {}) {
  const s = io(BASE, { transports: ["websocket"] });
  await once(s, "connect");
  await new Promise((resolve) =>
    s.emit("room:join", { roomId, name, color: "#BAFFC9", isHost: false, ...extra }, resolve)
  );
  return s;
}
async function receivesStreamRequest(action, ms = 400) {
  let got = [];
  const onReq = (d) => got.push(d.guestSocketId);
  host.on("stream:request", onReq);
  const result = await action();
  await new Promise((r) => setTimeout(r, ms));
  host.off("stream:request", onReq);
  return { got, result };
}

const holder = await receivesStreamRequest(() => joinGuest("Holder", { mediaFileId: fileId }));
check("guest rejoining with the file gets no stream:request", holder.got.length === 0);
holder.result.disconnect();

// Stream mode off: nobody gets streamed to.
const modePromise = once(guest, "room:stream-mode");
host.emit("host:stream-mode", { enabled: false });
check("room:stream-mode broadcast", (await modePromise).enabled === false);
const byo = await receivesStreamRequest(() => joinGuest("BYO"));
check("stream mode off: new guest gets no stream:request", byo.got.length === 0);

// Back on: host is asked to stream to exactly the guests that lack the file.
const reOn = await receivesStreamRequest(async () => host.emit("host:stream-mode", { enabled: true }));
check(
  "stream mode on: requests only guests without the file",
  reOn.got.includes(guest.id) && reOn.got.includes(byo.result.id) && !reOn.got.includes(late.id)
);
byo.result.disconnect();

const resumed = await receivesStreamRequest(async () => host.emit("host:resume-file"));
check("host:resume-file skips guests that have the file", resumed.got.includes(guest.id) && !resumed.got.includes(late.id));

// RTC signaling relay host -> guest
const offerPromise = once(late, "rtc:offer");
host.emit("rtc:offer", { targetSocketId: streamReq.guestSocketId, sdp: { type: "offer", sdp: "x" } });
const offer = await offerPromise;
check("rtc:offer relayed to guest", offer.sdp?.sdp === "x" && offer.fromSocketId === host.id);

// Reaction broadcast
const reactionPromise = once(guest, "reaction");
guest.emit("reaction:send", { emoji: "🔥" });
const reaction = await reactionPromise;
check("reaction broadcast", reaction.emoji === "🔥" && reaction.user === "Guest");

// Host disconnect → guests get host:disconnected
const hostDownPromise = once(guest, "host:disconnected", 4000);
host.disconnect();
const down = await hostDownPromise;
check("host:disconnected with grace period", down.graceMs === 30000);

guest.disconnect();
late.disconnect();

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
