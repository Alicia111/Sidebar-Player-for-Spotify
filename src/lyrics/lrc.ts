export interface LyricLine {
  timeMs: number;
  text: string;
}

// [mm:ss], [mm:ss.x], [mm:ss.xx] or [mm:ss.xxx]; also accepts ':' as the fraction separator.
const TIMESTAMP_PATTERN = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_PATTERN = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

/**
 * Parses LRC text into time-sorted lines. A line may carry several timestamps
 * (a repeated chorus); metadata tags like [ar:...] are skipped.
 */
export function parseLrc(source: string): LyricLine[] {
  const lines: LyricLine[] = [];
  let offsetMs = 0;

  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const offsetMatch = OFFSET_PATTERN.exec(trimmed);
    if (offsetMatch) {
      // Per the LRC convention, a positive offset makes lyrics appear sooner.
      offsetMs = Number(offsetMatch[1]);
      continue;
    }

    const timestamps = [...trimmed.matchAll(TIMESTAMP_PATTERN)];
    if (timestamps.length === 0) continue;
    const text = trimmed.slice(lastIndexAfter(timestamps)).trim();
    for (const match of timestamps) {
      lines.push({ timeMs: toMilliseconds(match), text });
    }
  }

  return lines
    .map((line) => ({ timeMs: Math.max(0, line.timeMs - offsetMs), text: line.text }))
    .sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line being sung at `positionMs`, or -1 before the first line. */
export function findActiveLineIndex(lines: readonly LyricLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let active = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].timeMs <= positionMs) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return active;
}

function toMilliseconds(match: RegExpMatchArray): number {
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ?? '0';
  // "5" means 500 ms, "05" means 50 ms, "005" means 5 ms.
  const fractionMs = Number(fraction.padEnd(3, '0'));
  return (minutes * 60 + seconds) * 1000 + fractionMs;
}

function lastIndexAfter(matches: RegExpMatchArray[]): number {
  const last = matches[matches.length - 1];
  return (last.index ?? 0) + last[0].length;
}
