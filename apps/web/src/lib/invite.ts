/** Shareable link that drops a friend straight into the room. */
export function roomLink(roomId: string): string {
  return `${window.location.origin}/room/${roomId}`;
}

/** Pull a room code out of whatever was typed or pasted: a bare code or a full invite link. */
export function extractRoomCode(input: string): string {
  const trimmed = input.trim();
  const fromLink = trimmed.match(/\/room\/([A-Za-z0-9]{6})/);
  return (fromLink ? fromLink[1] : trimmed).toUpperCase();
}

/**
 * navigator.clipboard only exists in secure contexts (HTTPS / localhost), so
 * fall back to the legacy copy command for plain-HTTP LAN addresses.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
