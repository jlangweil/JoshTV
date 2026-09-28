import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** logs/ at the repo root: one file per day, so nothing scrolls out of the console. */
const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../logs");
let stream: WriteStream | null = null;
let streamDay = "";

function fileFor(day: string): WriteStream | null {
  if (stream && streamDay === day) return stream;
  try {
    mkdirSync(logDir, { recursive: true });
    stream?.end();
    stream = createWriteStream(path.join(logDir, `joshtv-${day}.log`), { flags: "a" });
    streamDay = day;
    return stream;
  } catch {
    return null; // console only
  }
}

/**
 * Newlines and control characters (incl. terminal escape codes) come from
 * clients — names, diagnostics — so strip them: one event is always exactly
 * one line, and nobody can forge extra log lines or drive the terminal.
 */
export function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
}

/** One line per event, tagged with room and person, to the console and today's log file. */
export function logLine(roomId: string | null, who: string, text: string): void {
  const now = new Date();
  const line = `${now.toISOString().slice(11, 19)} [${roomId ?? "------"}] ${clean(who) || "?"}: ${clean(text)}`;
  console.log(line);
  fileFor(now.toISOString().slice(0, 10))?.write(line + "\n");
}

export function logDirectory(): string {
  return logDir;
}
