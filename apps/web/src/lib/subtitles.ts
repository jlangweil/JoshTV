/** Convert SRT subtitle text to WebVTT. Passes .vtt content through unchanged. */
export function toVtt(content: string, fileName: string): string {
  if (/\.vtt$/i.test(fileName) || content.trimStart().startsWith("WEBVTT")) {
    return content;
  }
  // SRT -> VTT: add header, swap comma decimal separators in timestamps.
  const body = content
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) return "";
      // Drop a leading numeric cue index if present.
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      return lines
        .map((line) =>
          line.replace(
            /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/,
            "$1.$2 --> $3.$4"
          )
        )
        .join("\n");
    })
    .filter((b) => b !== "")
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
