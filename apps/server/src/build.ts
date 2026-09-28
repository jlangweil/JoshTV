import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const indexHtml = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/index.html");
let cached: { mtime: number; id: string | null } | null = null;

/**
 * The web build currently being served: its hashed entry bundle name
 * (e.g. "index-Dn0z4sBw"), re-read whenever index.html changes (a rebuild).
 * Null when there's no production build (dev mode).
 */
export function currentWebBuild(): string | null {
  try {
    const mtime = statSync(indexHtml).mtimeMs;
    if (!cached || cached.mtime !== mtime) {
      const html = readFileSync(indexHtml, "utf8");
      cached = { mtime, id: /\/assets\/(index-[\w-]+)\.js/.exec(html)?.[1] ?? null };
    }
    return cached.id;
  } catch {
    return null;
  }
}
