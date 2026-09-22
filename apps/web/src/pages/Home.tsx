import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createRoom, getRoomInfo } from "../lib/api";
import { Identity, loadIdentity, saveIdentity, saveHostToken } from "../lib/identity";
import { IdentityForm } from "../components/IdentityForm";

export default function HomePage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity());
  const [joinCode, setJoinCode] = useState("");
  const [hostPassword, setHostPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const host = async () => {
    setBusy(true);
    setError(null);
    try {
      const { roomId, hostToken } = await createRoom(hostPassword || undefined);
      saveHostToken(roomId, hostToken);
      navigate(`/room/${roomId}`);
    } catch {
      setError("Could not create a room. Is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) return setError("Room codes are 6 characters.");
    setBusy(true);
    setError(null);
    try {
      const info = await getRoomInfo(code);
      if (!info?.exists) {
        setError("Room not found — check the code.");
      } else {
        navigate(`/room/${code}`);
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="film-grain relative flex min-h-dvh flex-col items-center justify-center gap-10 px-6 py-16">
      <header className="text-center">
        <h1 className="font-display text-6xl tracking-tight text-cinema-text max-sm:text-4xl">
          Sync<span className="text-cinema-accent">Cine</span>
        </h1>
        <p className="mt-3 text-lg text-cinema-muted">Host a movie night. Everyone watches in perfect sync.</p>
      </header>

      {!identity ? (
        <section className="flex flex-col items-center gap-4 rounded-2xl border border-cinema-surface bg-cinema-panel p-8">
          <h2 className="font-display text-2xl">First, who are you?</h2>
          <IdentityForm
            onSubmit={(id) => {
              saveIdentity(id);
              setIdentity(id);
            }}
          />
        </section>
      ) : (
        <section className="flex w-full max-w-3xl flex-col gap-6 sm:flex-row">
          <div className="flex flex-1 flex-col gap-3 rounded-2xl border border-cinema-surface bg-cinema-panel p-6">
            <h2 className="font-display text-2xl">Host a Movie Night</h2>
            <p className="text-sm text-cinema-muted">
              You pick a local MP4. It streams peer-to-peer to up to 10 friends, or everyone plays their own copy in sync.
            </p>
            <input
              type="password"
              className="rounded-lg border border-cinema-surface bg-cinema-bg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cinema-accent"
              placeholder="Optional room password"
              value={hostPassword}
              onChange={(e) => setHostPassword(e.target.value)}
              aria-label="Optional room password"
            />
            <button
              type="button"
              onClick={host}
              disabled={busy}
              className="rounded-lg bg-cinema-accent px-4 py-2.5 font-semibold text-white transition-colors hover:bg-cinema-accent/80 disabled:opacity-50"
            >
              Create Room
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-3 rounded-2xl border border-cinema-surface bg-cinema-panel p-6">
            <h2 className="font-display text-2xl">Join with Code</h2>
            <p className="text-sm text-cinema-muted">Got a 6-character code from a friend?</p>
            <input
              className="rounded-lg border border-cinema-surface bg-cinema-bg px-3 py-2 text-center font-mono text-lg uppercase tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-cinema-accent"
              placeholder="ABC123"
              maxLength={6}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && join()}
              aria-label="Room code"
            />
            <button
              type="button"
              onClick={join}
              disabled={busy}
              className="rounded-lg border border-cinema-accent px-4 py-2.5 font-semibold text-cinema-accent transition-colors hover:bg-cinema-accent/10 disabled:opacity-50"
            >
              Join Room
            </button>
          </div>
        </section>
      )}

      {identity && (
        <button
          type="button"
          className="text-sm text-cinema-muted underline hover:text-cinema-text"
          onClick={() => setIdentity(null)}
        >
          Watching as <span style={{ color: identity.color }}>{identity.name}</span> — change
        </button>
      )}

      {error && <p className="text-sm text-cinema-accent">{error}</p>}
    </div>
  );
}
