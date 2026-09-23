export interface ByteRange {
  start: number;
  end: number;
}

/** Which byte ranges of a file are present: sorted, merged [start, end) intervals. */
export class ByteCoverage {
  private ranges: Array<[number, number]> = [];

  /** Marks [start, end) present; returns how many of those bytes are new. */
  add(start: number, end: number): number {
    let added = 0;
    for (const [s, e] of this.missing(start, end)) added += e - s;
    if (!added) return 0;
    let s = start;
    let e = end;
    const out: Array<[number, number]> = [];
    for (const [a, b] of this.ranges) {
      if (b < s || a > e) out.push([a, b]);
      else {
        s = Math.min(s, a);
        e = Math.max(e, b);
      }
    }
    out.push([s, e]);
    out.sort((x, y) => x[0] - y[0]);
    this.ranges = out;
    return added;
  }

  /** Forgets [start, end) (evicted data); returns how many bytes were dropped. */
  remove(start: number, end: number): number {
    let removed = 0;
    const out: Array<[number, number]> = [];
    for (const [a, b] of this.ranges) {
      if (b <= start || a >= end) {
        out.push([a, b]);
        continue;
      }
      removed += Math.min(b, end) - Math.max(a, start);
      if (a < start) out.push([a, start]);
      if (b > end) out.push([end, b]);
    }
    this.ranges = out;
    return removed;
  }

  /** Sub-ranges of [start, end) not present yet. */
  missing(start: number, end: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let pos = start;
    for (const [a, b] of this.ranges) {
      if (b <= pos) continue;
      if (a >= end) break;
      if (a > pos) out.push([pos, a]);
      pos = Math.max(pos, b);
      if (pos >= end) break;
    }
    if (pos < end) out.push([pos, end]);
    return out;
  }

  /** End of the present run containing `pos`, or `pos` itself if that byte is missing. */
  contiguousEnd(pos: number): number {
    for (const [a, b] of this.ranges) if (a <= pos && pos < b) return b;
    return pos;
  }

  /** First missing range at or after `from` (clipped to `total`), ending where data resumes. */
  firstGap(from: number, total: number): ByteRange | null {
    const [gap] = this.missing(from, total);
    return gap ? { start: gap[0], end: gap[1] } : null;
  }
}
