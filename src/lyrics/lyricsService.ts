import type { Track } from '../api/types.ts';
import { fetchLyrics, type LyricsResult } from './lrclib.ts';

// Enough to cover a listening session's back-and-forth without growing forever.
const MAX_CACHED_TRACKS = 50;

/** Fetches lyrics once per track and remembers the answer, including "not found". */
export class LyricsService {
  private readonly fetchFn: typeof fetch;
  private readonly cache = new Map<string, Promise<LyricsResult>>();

  constructor(fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  getLyrics(track: Track): Promise<LyricsResult> {
    const cached = this.cache.get(track.uri);
    if (cached) return cached;

    const pending = fetchLyrics(
      {
        trackName: track.name,
        artistName: track.artists[0]?.name ?? '',
        albumName: track.album.name,
        durationSeconds: track.duration_ms / 1000,
      },
      this.fetchFn,
    );
    // Failures are not cached, so a retry (or the next play) asks LRCLIB again.
    pending.catch(() => this.cache.delete(track.uri));
    this.remember(track.uri, pending);
    return pending;
  }

  forget(trackUri: string): void {
    this.cache.delete(trackUri);
  }

  private remember(trackUri: string, pending: Promise<LyricsResult>): void {
    if (this.cache.size >= MAX_CACHED_TRACKS) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(trackUri, pending);
  }
}
