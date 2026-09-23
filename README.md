# JoshTV (joshtv-fable)

Host a movie night: one host loads a **local MP4** and up to **10 viewers** watch it in
perfect sync, with real-time chat, floating emoji reactions, and a fullscreen mode that
keeps the chat reachable. The file never touches a server — it streams peer-to-peer
from the host's browser over WebRTC DataChannels, or each viewer plays their own local
copy and only the playback state is synced.

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

Open http://localhost:5173, create a room, load an MP4, and click **Copy invite link**
to share the room. Friends who open the link are asked for a name and avatar color the
first time; after that their browser remembers them and the link drops them straight in.
To test locally, join from an incognito window or a different browser (a normal second
tab is recognized as the host).

### Production build

```sh
npm run build      # fable + server tsc + vite build
npm start          # serves API, sockets, AND the built web app on :3001
```

### Smoke test

```sh
node apps/server/dist/index.js &   # or npm start
node scripts/smoke.mjs             # 26 protocol checks (join, sync, chat, RTC relay, own-copy mode…)
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
  ordered, reliable RTCDataChannel with backpressure (1MB high-water mark). Every chunk
  carries its byte offset, and a guest can redirect its stream to any byte range.
- Guests store incoming bytes in Blobs (outside the page's JS memory), and a feeder
  remuxes them to fragmented MP4 with **mp4box.js** for MSE, only ~30s ahead of the
  playhead, releasing what's been used. Guest memory stays roughly flat whatever the
  movie size (a 150MB test movie peaks around 20–40MB of JS heap). Guests report
  buffered-ahead seconds every 500ms (BF-02).
- **Late joiners start where the room is.** Once the MP4 index (`moov`) arrives, the guest
  looks up the byte offset of the keyframe at the room's current position. If it doesn't
  have that data and the stream won't reach it within ~8s, it asks the host to jump there.
  The skipped bytes are backfilled afterwards. The same kicks in when the host seeks
  somewhere a guest hasn't downloaded. Joining at 4:00 of a 150MB file over a ~5 MB/s link
  plays in sync in under a second instead of ~24s.
- Every raw chunk is also retained; when the transfer completes the player switches to
  a **Blob URL** — the whole movie is then natively buffered locally, so playback can
  never be interrupted by network hiccups and any seek is instant.
- Non-faststart MP4s (moov at end) can't remux progressively: guests then wait for the
  full transfer and play from the blob, showing a "waiting for full download" notice meanwhile.
- Reconnects use exponential backoff 500ms → 8s (BF-06); on rejoin the server re-sends
  full state and asks the host to re-open the stream (BF-07) — unless the guest already
  holds the whole file, in which case nothing is re-sent.

## iPad / iPhone (Safari)

iPadOS Safari is a first-class client, for guests and for hosts:

- **Leaving Safari / locking the screen.** iOS suspends the page, pauses the video and
  silently kills its connections. The app recovers on return:
  - It probes the socket, since it can look connected while dead for ~45s, and reconnects
    within ~3s if it's gone.
  - A stalled download asks the host for a new stream and resumes where it left off.
  - The guest catches up to the room's position.
  - If the host was the one away, its guests' streams are re-offered, and the room is set
    to whatever the host's video is actually doing (iOS paused it while the socket was dead).
- **Memory.** Safari kills tabs that hold too much, and WebKit keeps Blob data in RAM. So
  guests save downloads to disk in the origin-private file system (OPFS, Safari 15.2+),
  via a worker. The finished movie plays from that file, just like a local copy. MSE is
  fed only ~30s ahead, with old data trimmed.
  - Without OPFS (private browsing, too little storage), iOS guests with movies over 300MB
    stream only: they keep a ~2-minute window around the playhead and never build the
    whole file.
  - Elsewhere without OPFS, Blobs are used; Chrome pages them to disk.
- **Autoplay.** Sound starts on. Where iOS refuses it, playback continues muted and sound
  comes on at the first tap (iOS doesn't send `click` for taps on plain areas, so
  `touchend`/`pointerup` count too). In Low Power Mode, iOS blocks even muted autoplay,
  so a "Tap to start playback" prompt appears.
- **Decoder torn down in the background.** iOS can kill a backgrounded page's video
  decoder ("Media failed to decode"), which permanently breaks its MSE pipeline. Once the
  page is visible again, the app rebuilds the pipeline from a saved copy of the file header
  and lands at the room's position. A plain file (finished download, own copy, the host's
  file) is reloaded. Rebuilds are capped at 4 a minute.
- **Screen lock.** A screen wake lock is held while the room is playing.
- **Use HTTPS for iPads.** Over plain `http://<LAN IP>`, Safari hides the storage API, so
  iPads can't save the movie to disk. They fall back to streaming only (logged as
  `opfs=false`). Wake lock also needs HTTPS. A tunnel such as
  `cloudflared tunnel --url http://localhost:3001` gives HTTPS for local testing.
- **Controls.**
  - The volume slider is hidden: iOS only allows hardware volume.
  - Fullscreen keeps the chat on iPad (element fullscreen). iPhone falls back to the
    native video player.
  - PiP uses Safari's presentation-mode API where the standard one is missing.
  - Touch targets are ≥44px on touch screens, with no double-tap zoom and safe-area
    padding for the home indicator.
  - The chat input is 16px so focusing it doesn't zoom the page.
  - The subtitle picker accepts any file on iOS, because iOS greys out `.srt`/`.vtt`,
    and checks the extension afterwards.
- **iPhone** has only `ManagedMediaSource`, which is used with AirPlay disabled (it won't
  open otherwise).
- **Back/forward cache.** A page restored from Safari's bfcache reloads.

Tested in Edge with iPad emulation plus simulations of these iOS behaviours. Not yet
verified on a physical iPad.

### Diagnostics

Safari's dev tools on an iPad need a Mac, so clients report to the server console
instead. `npm start` prints one line per event, tagged with room and name:

```
16:31:42 [44QHRY] iPad: [client] joined as guest | <user agent> | opfs=true free=10737MB
16:31:42 [44QHRY] iPad: [client] stream start: 2103MB, storage=disk
16:31:50 [44QHRY] iPad: [client] jump to 3600s (byte 1402MB, have nothing there)
16:32:17 [44QHRY] iPad: [client] download complete: playing the whole file from disk
16:33:05 [44QHRY] iPad: left (transport close)
```

- **Leave reasons.** `transport close` means the page or tab went away. `ping timeout`
  means it went silent (suspended, network gone). `client namespace disconnect` is a
  normal leave.
- **Crashes.** A tab that crashes leaves no trace itself, but the next load reports it:
  `previous page ended abruptly … while: <what it was doing>`.
- **Errors.** JS errors and `<video>` errors are reported as they happen.

## Own-copy mode (local file as the source)

If viewers already have the movie, nothing needs to stream:

- **Any viewer** can click **Use my own copy** (header, the "Connecting…" overlay, or the
  buffering chip) and pick the file from their computer. Their stream is dropped and they
  play the local file, still driven by the host's play/pause/seek/speed.
- **The host** can untick **Stream to viewers**: nothing is sent from the host's machine
  and every viewer is prompted to load their own copy. Ticking it again streams only to
  viewers who don't have the file yet.
- Copies don't need to be byte-identical. If the sizes differ, the guest's file is probed
  and a warning shows when its duration is off by more than 2s (likely a different cut).
- Each load gets a server-assigned file id; buffer reports and streams are tagged with it,
  so a guest's stale media is dropped when the host replaces the video.
- If the host reloads the page, re-picking the same file resumes the room at its saved
  position instead of restarting everyone.

## Feature checklist

- Rooms: 6-char codes, shareable invite links (`/room/CODE`), 12h expiry, 10-guest cap,
  host-token auth (remembered per browser, so the host keeps control across tabs)
- Host disconnect → guests pause, 30s grace overlay, then "host left". When the host
  returns (even after the 30s), guests are told and the host's real play/pause state is
  re-applied (RM-07/08)
- One host at a time: the host token is remembered per browser, so a second tab or window
  on the host's machine asks **Watch as a viewer** or **Host here instead**. A tab that
  is taken over is told so and can take hosting back. The server first pings the current
  host tab and only treats it as active if it answers, so a host coming back after its old
  connection silently died isn't blocked. Reconnects of the hosting tab reclaim hosting
  without asking.
- Own-copy mode: viewers can play a local copy; host can turn streaming off entirely
- Sound on by default; if the browser blocks unmuted autoplay (no click on the page yet),
  the video plays muted in sync and sound turns on at the first click or key press
- Per-guest buffer health dots for the host: green/yellow/red (BF-03)
- Guests: read-only seek bar, ✋ pause requests the host can accept/dismiss (SP-09)
- Chat: 50-message history on join, @mention highlighting, emoji picker, system
  messages, unread badge, 3 msg/sec rate limit, reachable in fullscreen (CH-08)
- Reactions: 👏 😂 😱 ❤️ 🔥 float over the video for everyone (RC-01..03)
- Player: speed sync (0.5–1.5×), volume/mute (local), PiP, `.vtt`/`.srt` subtitles
  broadcast to all, controls auto-hide after 3s, keyboard (space/f/c), ARIA labels,
  `prefers-reduced-motion` respected
- Identity: display name + 12 pastel avatar colors in `localStorage`, no accounts —
  first-time visitors are prompted before joining, returning ones go straight in; the Home
  join box also accepts a pasted invite link

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
| **Any VPS** | `docker build -t joshtv . && docker run -p 80:3001 joshtv` behind a TLS proxy (Caddy/nginx). |
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
- Jumping to the room's position needs the MP4 index at the front of the file
  ("faststart"). For files with the index at the end, guests wait for the full download.
  `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` fixes a file without re-encoding.
- In-memory room state: restarting the server drops rooms (Redis adapter is the
  documented scale-out path).
