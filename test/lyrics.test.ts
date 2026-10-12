import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Track } from '../src/api/types.ts';
import { findActiveLineIndex, parseLrc } from '../src/lyrics/lrc.ts';
import { fetchLyrics, LyricsRequestError, pickBestCandidate } from '../src/lyrics/lrclib.ts';
import { LyricsService } from '../src/lyrics/lyricsService.ts';
import { parseLyricsWebviewMessage } from '../src/shared/lyricsProtocol.ts';

// Fixtures are placeholder text, not real song lyrics.
const SAMPLE_LRC = ['[ar:Test Artist]', '[00:01.00]line one', '[00:05.5]line two', '[00:09.250][00:20.00]repeated line', '[00:12.00]'].join('\n');

const query = { trackName: 'Test Song', artistName: 'Test Artist', albumName: 'Test Album', durationSeconds: 200 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function routedFetch(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url.pathname);
    const route = routes[url.pathname];
    if (!route) throw new Error(`Unexpected request to ${url}`);
    return route();
  }) as typeof fetch;
  return { fetchFn, requested };
}

describe('parseLrc', () => {
  it('parses timestamps, repeats and empty lines, skipping metadata', () => {
    assert.deepEqual(parseLrc(SAMPLE_LRC), [
      { timeMs: 1000, text: 'line one' },
      { timeMs: 5500, text: 'line two' },
      { timeMs: 9250, text: 'repeated line' },
      { timeMs: 12000, text: '' },
      { timeMs: 20000, text: 'repeated line' },
    ]);
  });

  it('applies the offset tag (positive shows lines earlier)', () => {
    assert.deepEqual(parseLrc('[offset:+500]\n[00:02.00]line one'), [{ timeMs: 1500, text: 'line one' }]);
  });

  it('returns nothing for text without timestamps', () => {
    assert.deepEqual(parseLrc('just some words\nmore words'), []);
  });
});

describe('findActiveLineIndex', () => {
  const lines = parseLrc(SAMPLE_LRC);

  it('finds the last line that has started', () => {
    assert.equal(findActiveLineIndex(lines, 0), -1);
    assert.equal(findActiveLineIndex(lines, 1000), 0);
    assert.equal(findActiveLineIndex(lines, 7000), 1);
    assert.equal(findActiveLineIndex(lines, 999_999), lines.length - 1);
    assert.equal(findActiveLineIndex([], 5000), -1);
  });
});

describe('fetchLyrics', () => {
  it('uses the exact match and parses synced lyrics', async () => {
    const { fetchFn, requested } = routedFetch({
      '/api/get': () => jsonResponse({ duration: 200, instrumental: false, plainLyrics: 'line one', syncedLyrics: '[00:01.00]line one' }),
    });
    const result = await fetchLyrics(query, fetchFn);
    assert.deepEqual(result, { kind: 'synced', lines: [{ timeMs: 1000, text: 'line one' }] });
    assert.deepEqual(requested, ['/api/get']);
  });

  it('falls back to search and only accepts a matching duration', async () => {
    const { fetchFn } = routedFetch({
      '/api/get': () => jsonResponse({ code: 404 }, 404),
      '/api/search': () =>
        jsonResponse([
          { duration: 320, instrumental: false, plainLyrics: 'wrong version', syncedLyrics: null },
          { duration: 201, instrumental: false, plainLyrics: 'line one\nline two', syncedLyrics: null },
        ]),
    });
    assert.deepEqual(await fetchLyrics(query, fetchFn), { kind: 'plain', text: 'line one\nline two' });
  });

  it('reports not found when no candidate is close enough', async () => {
    const { fetchFn } = routedFetch({
      '/api/get': () => jsonResponse({}, 404),
      '/api/search': () => jsonResponse([{ duration: 90, instrumental: false, plainLyrics: 'other song', syncedLyrics: null }]),
    });
    assert.deepEqual(await fetchLyrics(query, fetchFn), { kind: 'notFound' });
  });

  it('recognises instrumentals', async () => {
    const { fetchFn } = routedFetch({
      '/api/get': () => jsonResponse({ duration: 200, instrumental: true, plainLyrics: null, syncedLyrics: null }),
    });
    assert.deepEqual(await fetchLyrics(query, fetchFn), { kind: 'instrumental' });
  });

  it('ignores oversized lyric payloads', async () => {
    const { fetchFn } = routedFetch({
      '/api/get': () => jsonResponse({ duration: 200, instrumental: false, plainLyrics: 'x'.repeat(200_000), syncedLyrics: null }),
    });
    assert.deepEqual(await fetchLyrics(query, fetchFn), { kind: 'notFound' });
  });

  it('throws a typed error on server failures', async () => {
    const { fetchFn } = routedFetch({ '/api/get': () => jsonResponse({}, 503) });
    await assert.rejects(fetchLyrics(query, fetchFn), LyricsRequestError);
  });
});

describe('pickBestCandidate', () => {
  it('prefers synced lyrics, then the closest duration', () => {
    const plainClose = { duration: 200, instrumental: false, plainLyrics: 'a', syncedLyrics: null };
    const syncedFar = { duration: 202, instrumental: false, plainLyrics: 'b', syncedLyrics: '[00:01.00]b' };
    assert.equal(pickBestCandidate([plainClose, syncedFar], 200), syncedFar);
  });
});

describe('LyricsService', () => {
  const track = {
    type: 'track',
    id: 't1',
    name: 'Test Song',
    uri: 'spotify:track:t1',
    duration_ms: 200_000,
    artists: [{ id: 'a', name: 'Test Artist', uri: 'spotify:artist:a' }],
    album: { id: 'al', name: 'Test Album', uri: 'spotify:album:al', images: [], artists: [] },
  } satisfies Track;

  it('caches results per track', async () => {
    const { fetchFn, requested } = routedFetch({
      '/api/get': () => jsonResponse({ duration: 200, instrumental: true, plainLyrics: null, syncedLyrics: null }),
    });
    const service = new LyricsService(fetchFn);
    await service.getLyrics(track);
    await service.getLyrics(track);
    assert.equal(requested.length, 1);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return calls === 1 ? jsonResponse({}, 500) : jsonResponse({ duration: 200, instrumental: true, plainLyrics: null, syncedLyrics: null });
    }) as typeof fetch;
    const service = new LyricsService(fetchFn);
    await assert.rejects(service.getLyrics(track));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await service.getLyrics(track), { kind: 'instrumental' });
  });
});

describe('parseLyricsWebviewMessage', () => {
  it('accepts valid messages and rejects malformed ones', () => {
    assert.deepEqual(parseLyricsWebviewMessage({ type: 'seek', positionMs: 1200 }), { type: 'seek', positionMs: 1200 });
    assert.deepEqual(parseLyricsWebviewMessage({ type: 'retry' }), { type: 'retry' });
    assert.equal(parseLyricsWebviewMessage({ type: 'seek', positionMs: -5 }), null);
    assert.equal(parseLyricsWebviewMessage({ type: 'seek', positionMs: 'soon' }), null);
    assert.equal(parseLyricsWebviewMessage({ type: 'openUrl', url: 'https://example.com' }), null);
  });
});
