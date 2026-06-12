export interface RoomInfo {
  exists: boolean;
  hasPassword: boolean;
  guestCount: number;
  maxGuests: number;
  hasFile: boolean;
  hostConnected: boolean;
}

export async function createRoom(password?: string): Promise<{ roomId: string; hostToken: string }> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: password || undefined }),
  });
  if (!res.ok) throw new Error("Failed to create room");
  return res.json();
}

export async function getRoomInfo(roomId: string): Promise<RoomInfo | null> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to look up room");
  return res.json();
}
