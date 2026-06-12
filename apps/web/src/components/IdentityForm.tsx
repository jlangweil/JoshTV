import { useState } from "react";
import { AVATAR_COLORS } from "../types";
import { Identity, randomColor } from "../lib/identity";

interface Props {
  initial?: Identity | null;
  submitLabel?: string;
  onSubmit: (identity: Identity) => void;
}

/** UI-01/UI-02: pick a display name and one of 12 pastel avatar colors. */
export function IdentityForm({ initial, submitLabel = "Continue", onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? randomColor());

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed) onSubmit({ name: trimmed.slice(0, 24), color });
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-cinema-muted">Display name</span>
        <input
          className="rounded-lg border border-cinema-surface bg-cinema-bg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-cinema-accent"
          value={name}
          maxLength={24}
          placeholder="e.g. Josh"
          onChange={(e) => setName(e.target.value)}
          autoFocus
          aria-label="Display name"
        />
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-cinema-muted">Avatar color</span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar color">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`Color ${c}`}
              className={`h-7 w-7 rounded-full transition-transform ${
                color === c ? "scale-125 ring-2 ring-cinema-accent ring-offset-2 ring-offset-cinema-bg" : ""
              }`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <button
        type="submit"
        disabled={!name.trim()}
        className="rounded-lg bg-cinema-accent px-4 py-2 font-semibold text-white transition-colors hover:bg-cinema-accent/80 disabled:opacity-40"
      >
        {submitLabel}
      </button>
    </form>
  );
}
