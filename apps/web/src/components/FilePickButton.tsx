import { ReactNode } from "react";

export const VIDEO_ACCEPT = "video/mp4,video/webm,.mp4,.m4v,.webm";

interface Props {
  onPick: (file: File) => void;
  children: ReactNode;
  className?: string;
  accept?: string;
  title?: string;
}

/** A styled label wrapping a hidden file input. */
export function FilePickButton({ onPick, children, className, accept = VIDEO_ACCEPT, title }: Props) {
  return (
    <label
      title={title}
      className={
        className ??
        "touch-target cursor-pointer rounded-lg bg-cinema-surface px-2 py-1 hover:bg-cinema-surface/70 focus-within:ring-2 focus-within:ring-cinema-accent"
      }
    >
      {children}
      <input
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}
