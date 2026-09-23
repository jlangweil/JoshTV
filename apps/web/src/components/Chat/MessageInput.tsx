import { useState } from "react";

const PICKER_EMOJIS = [
  "\u{1F600}", "\u{1F602}", "\u{1F60D}", "\u{1F914}", "\u{1F62E}", "\u{1F622}",
  "\u{1F621}", "\u{1F44D}", "\u{1F44E}", "\u{1F44F}", "\u{1F64C}", "\u{1F525}",
  "\u{2764}\u{FE0F}", "\u{1F389}", "\u{1F37F}", "\u{1F3AC}", "\u{1F3A5}", "\u{1F62D}",
  "\u{1F631}", "\u{1F923}", "\u{1F60E}", "\u{1F634}", "\u{1F440}", "\u{1F4AF}",
];

export function MessageInput({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="relative border-t border-cinema-surface p-2">
      {pickerOpen && (
        <div className="absolute bottom-full left-2 right-2 mb-1 grid grid-cols-8 gap-1 rounded-xl border border-cinema-surface bg-cinema-panel p-2 shadow-xl">
          {PICKER_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              className="rounded p-1 text-lg hover:bg-cinema-surface"
              onClick={() => {
                setText((t) => t + e);
                setPickerOpen(false);
              }}
              aria-label={`Insert ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="touch-target rounded-lg px-2 py-1 text-lg hover:bg-cinema-surface focus:outline-none focus:ring-2 focus:ring-cinema-accent"
          onClick={() => setPickerOpen((o) => !o)}
          aria-label="Emoji picker"
        >
          {"\u{1F600}"}
        </button>
        <input
          className="min-w-0 flex-1 rounded-lg border border-cinema-surface bg-cinema-bg px-3 py-1.5 text-base sm:text-sm placeholder:text-cinema-muted focus:outline-none focus:ring-2 focus:ring-cinema-accent"
          placeholder="Say something…"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Chat message"
        />
        <button
          type="button"
          className="touch-target rounded-lg bg-cinema-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-cinema-accent/80 focus:outline-none focus:ring-2 focus:ring-cinema-accent"
          onClick={submit}
          aria-label="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
