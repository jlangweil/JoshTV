import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRoom, getRoom, sweepIdleRooms, roomCount } from "./rooms.js";
import { registerHandlers } from "./handlers.js";
import { MAX_GUESTS } from "./types.js";

const PORT = Number(process.env.PORT) || 3001;
const app = express();
app.use(express.json());

// Dev runs web and server on different origins.
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.post("/api/rooms", (_req, res) => {
  const room = createRoom();
  res.json({ roomId: room.roomId, hostToken: room.hostToken });
});

app.get("/api/rooms/:id", (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ exists: false });
  const guestCount = [...room.users.values()].filter((u) => !u.isHost).length;
  res.json({
    exists: true,
    guestCount,
    maxGuests: MAX_GUESTS,
    hasFile: room.fileMeta !== null,
    hostConnected: room.hostSocketId !== null,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: roomCount() });
});

// Serve the built web app in production.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  // Allow chunky signaling payloads (SDP with many candidates, VTT uploads).
  maxHttpBufferSize: 4_000_000,
});

io.on("connection", (socket) => registerHandlers(io, socket));

setInterval(() => {
  const expired = sweepIdleRooms();
  for (const id of expired) {
    io.to(id).emit("room:closed");
  }
}, 60_000);

httpServer.listen(PORT, () => {
  console.log(`JoshTV server listening on http://localhost:${PORT}`);
});
