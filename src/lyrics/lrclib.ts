import { parseLrc, type LyricLine } from './lrc.ts';

const LRCLIB_BASE_URL = 'https://lrclib.net/api';
// Injected by esbuild from package.json; absent when tests run the sources directly.
declare const __EXTENSION_VERSION__: string | undefined;
const EXTENSION_VERSION = typeof __EXTENSION_VERSION__ === 'string' ? __EXTENSION_VERSION__ : 'dev';
// LRCLIB asks clients to identify themselves.
const USER_AGENT = `spotify-sidebar-vscode/${EXTENSION_VERSION}`;
const REQUEST_TIMEOUT_MS = 10_000;
// Search fallback: accept a match only if its length is this close to the playing track.
const MAX_DURATION_DIFFERENCE_SECONDS = 3;
// Guards against a hostile or broken response flooding the webview.
const MAX_LYRICS_LENGTH = 100_000;

export interface LyricsQuery {
  trackName: string;
  artistName: string;
  albumName: string;
  durationSeconds: number;
}

export type LyricsResult =
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'plain'; text: string }
  | { kind: 'instrumental' }
  | { kind: 'notFound' };

export class LyricsRequestError extends Error {
  readonly status: number;

  constructor(status: number, endpoint: string) {
    super(`LRCLIB ${endpoint} failed with HTTP ${status}`);
    this.name = 'LyricsRequestError';
    this.status = status;
  }
}

interface LrclibRecord {
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/** Looks up lyrics for a track: exact signature match first, then a duration-checked search. */
export async function fetchLyrics(query: LyricsQuery, fetchFn: typeof fetch = fetch): Promise<LyricsResult> {
  const exact = await getExactMatch(query, fetchFn);
  if (exact) return toResult(exact);

  const candidates = await searchCandidates(query, fetchFn);
  const best = pickBestCandidate(candidates, query.durationSeconds);
  return best ? toResult(best) : { kind: 'notFound' };
}

export function pickBestCandidate(candidates: LrclibRecord[], durationSeconds: number): LrclibRecord | undefined {
  const closeEnough = candidates.filter(
    (candidate) => Math.abs(candidate.duration - durationSeconds) <= MAX_DURATION_DIFFERENCE_SECONDS,
  );
  // Prefer time-synced lyrics, then the closest duration.
  return closeEnough.sort((a, b) => {
    const syncedOrder = Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics));
    return syncedOrder || Math.abs(a.duration - durationSeconds) - Math.abs(b.duration - durationSeconds);
  })[0];
}

function toResult(record: LrclibRecord): LyricsResult {
  if (record.instrumental) return { kind: 'instrumental' };
  if (record.syncedLyrics) {
    const lines = parseLrc(record.syncedLyrics);
    if (lines.length > 0) return { kind: 'synced', lines };
  }
  if (record.plainLyrics?.trim()) return { kind: 'plain', text: record.plainLyrics };
  return { kind: 'notFound' };
}

async function getExactMatch(query: LyricsQuery, fetchFn: typeof fetch): Promise<LrclibRecord | undefined> {
  const response = await request(fetchFn, '/get', {
    track_name: query.trackName,
    artist_name: query.artistName,
    album_name: query.albumName,
    duration: String(Math.round(query.durationSeconds)),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new LyricsRequestError(response.status, '/get');
  return parseRecord(await response.json());
}

async function searchCandidates(query: LyricsQuery, fetchFn: typeof fetch): Promise<LrclibRecord[]> {
  const response = await request(fetchFn, '/search', { track_name: query.trackName, artist_name: query.artistName });
  if (!response.ok) throw new LyricsRequestError(response.status, '/search');
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) return [];
  return payload.map(parseRecord).filter((record): record is LrclibRecord => record !== undefined);
}

function request(fetchFn: typeof fetch, endpoint: string, params: Record<string, string>): Promise<Response> {
  const url = `${LRCLIB_BASE_URL}${endpoint}?${new URLSearchParams(params)}`;
  return fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Validates one LRCLIB record; anything malformed is treated as no match. */
function parseRecord(raw: unknown): LrclibRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { duration, instrumental, plainLyrics, syncedLyrics } = raw as Record<string, unknown>;
  if (typeof duration !== 'number') return undefined;
  return {
    duration,
    instrumental: instrumental === true,
    plainLyrics: boundedText(plainLyrics),
    syncedLyrics: boundedText(syncedLyrics),
  };
}

function boundedText(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_LYRICS_LENGTH ? value : null;
}
