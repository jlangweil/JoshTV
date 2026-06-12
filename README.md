# SyncCine (joshtv-fable)

Host a movie night: one host loads a **local MP4** and up to **10 viewers** watch it in
perfect sync, with real-time chat, floating emoji reactions, and a fullscreen mode that
keeps the chat reachable. The file never touches a server — it streams peer-to-peer
from the host's browser over WebRTC DataChannels.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS |
| Sync logic | **F# compiled with Fable** (`packages/sync-engine`) — pure, testable state machine |
| Backend | Node.js + Express + Socket.IO (rooms, sync events, chat relay, WebRTC signaling) |
| Media | WebRTC DataChannels (512KB file reads → 64KB wire chunks with backpressure) + MediaSource Extensions (mp4box.js fMP4 remux) |

## Prerequisites

- Node.js 22+ (`nvm use 22.14.0`)
- .NET SDK 8/9 (for the Fable F# → JS compile)

## Run it

```sh
npm install
npm run dev        # compiles F# → JS, then starts server (:3001) + web (:5173)
```

Open http://localhost:5173, create a room, load an MP4, and share the room link.
To test locally, open a second browser window (or incognito) and join with the code.

### Production build

```sh
npm run build      # fable + server tsc + vite build
npm start          # serves API, sockets, AND the built web app on :3001
```

### Smoke test

```sh
node apps/server/dist/index.js &   # or npm start
node scripts/smoke.mjs             # 18 protocol checks (join, sync, chat, RTC relay…)
```

## How synchronization works

1. **Clock sync (SP-11):** each client runs 5 NTP-style ping exchanges over the socket
   on join and every 30s; the F# `ClockSync.computeOffset` takes the median offset.
2. **Authoritative host state (SP-01):** play/pause/seek/speed emit events stamped with
   server time; the server holds `{playing, currentTime, updatedAt, speed}` per room.
3. **Drift correction (SP-05..07):** every 500ms guests compute
   `expected = currentTime + (serverNow − updatedAt) × speed` (F# `SyncEngine`).
   Drift > 1.5s → silent re-seek. Drift > 3s → pause with "Catching up…" overlay,
   resume when within 0.5s and re-buffered.
4. **Heartbeat:** the host reports its real playhead every 10s so multi-hour sessions
   never accumulate drift.

## How streaming/buffering works

- Host reads the file in 512KB slices (BF-08) and sends 64KB chunks per guest over an
  ordered, reliable RTCDataChannel with backpressure (4MB high-water mark).
- Guests remux incoming bytes to fragmented MP4 with **mp4box.js** and feed MSE for a
  fast start (< 3s typical), reporting buffered-ahead seconds every 500ms (BF-02).
- Every raw chunk is also retained; when the transfer completes the player switches to
  a **Blob URL** — the whole movie is then natively buffered locally, so playback can
  never be interrupted by network hiccups and any seek is instant.
- Non-faststart MP4s (moov at end) can't remux progressively: guests then wait for the
  full transfer and play from the blob (the "Buffering gate" makes this seamless).
- Reconnects use exponential backoff 500ms → 8s (BF-06); on rejoin the server re-sends
  full state and asks the host to re-open the stream (BF-07).

## Feature checklist

- Rooms: 6-char codes, optional password, 12h expiry, 10-guest cap, host-token auth
- Host disconnect → 30s grace overlay; auto-resume on reconnect (RM-07/08)
- Buffering gate (SP-10): Play disabled until every viewer reports `readyState ≥ 3`
- Auto-pause on buffer-low toggle (BF-04) with per-guest green/yellow/red dots (BF-03)
- Guests: read-only seek bar, ✋ pause requests the host can accept/dismiss (SP-09)
- Chat: 50-message history on join, @mention highlighting, emoji picker, system
  messages, unread badge, 3 msg/sec rate limit, reachable in fullscreen (CH-08)
- Reactions: 👏 😂 😱 ❤️ 🔥 float over the video for everyone (RC-01..03)
- Player: speed sync (0.5–1.5×), volume/mute (local), PiP, `.vtt`/`.srt` subtitles
  broadcast to all, controls auto-hide after 3s, keyboard (space/f/c), ARIA labels,
  `prefers-reduced-motion` respected
- Identity: display name + 12 pastel avatar colors in `localStorage`, no accounts

## Repo layout

```
apps/web                React frontend (hooks own the realtime logic)
  src/fable-gen/        ← generated JS from F# (npm run fable)
  src/lib/              StreamAssembler (MSE), mp4 probing, protocol, srt→vtt
  src/hooks/            useRoomConnection, useHostStreamer, useGuestReceiver,
                        useDriftSync, useBufferReporter, useFullscreen
apps/server             Express + Socket.IO (rooms.ts, handlers.ts)
packages/sync-engine    F# source: SyncEngine.fs, ClockSync.fs, BufferManager.fs,
                        RoomState.fs, Api.fs (flat TS-friendly exports)
scripts/smoke.mjs       protocol smoke test
```

## Deploying publicly

The app is a **single deployable service**: the Node server hosts the API, the
Socket.IO websocket, and the built web app on one origin. The movie itself flows
peer-to-peer between browsers, so server bandwidth stays tiny (signaling + chat).

**Vercel alone won't work** — its serverless functions can't hold the long-lived
websocket connections Socket.IO needs. Use a platform that runs a persistent Node
process. Easiest options (all give you HTTPS automatically, which WebRTC requires
on the public internet):

| Platform | How |
|---|---|
| **Railway / Render / Fly.io** | Point at this repo; they detect the `Dockerfile` and build/run it. Done. |
| **Any VPS** | `docker build -t synccine . && docker run -p 80:3001 synccine` behind a TLS proxy (Caddy/nginx). |
| **Vercel (frontend) + Railway (server)** | Possible but unnecessary — you'd need to point the web app's socket/API at the server origin. The single-service deploy avoids that. |

The `Dockerfile` exists because the build needs both the .NET SDK (Fable F# → JS)
and Node; runtime is Node-only and respects the platform's `PORT` env var.

**For reliability across strangers' networks, add a TURN server.** The default
config is STUN-only, which fails for users behind strict/symmetric NATs (some
mobile carriers, corporate networks). Get free-tier TURN credentials from
[metered.ca](https://www.metered.ca/tools/openrelay/) or Twilio, then add them to
`RTC_CONFIG` in `apps/web/src/lib/streamProtocol.ts`:

```ts
iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:relay.example.com:443", username: "...", credential: "..." },
]
```

Note: TURN relays the video chunks through the relay server for affected users, so
relay bandwidth applies there.

## Known limitations (v1)

- Streaming is WebRTC-only; there is no server-relay fallback for networks where
  NAT traversal fails (would need a TURN server — add one to `RTC_CONFIG`).
- A guest who reconnects re-downloads the file from the start.
- Host seeking far ahead of what guests have received shows "Catching up…" until the
  sequential transfer reaches that position.
- In-memory room state: restarting the server drops rooms (Redis adapter is the
  documented scale-out path).
