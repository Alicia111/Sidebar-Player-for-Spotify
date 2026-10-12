import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunk, collectPages } from '../src/api/endpoints.ts';
import type { PlaybackState, SearchResponse, Track } from '../src/api/types.ts';
import { formatDuration } from '../src/shared/format.ts';
import { parseWebviewMessage } from '../src/shared/protocol.ts';
import { pickImageUrl, toArtistLinks, toNowPlayingView, toSearchResultsView } from '../src/state/viewModels.ts';

const sampleTrack: Track = {
  type: 'track',
  id: 'abc',
  name: 'Song',
  uri: 'spotify:track:abc',
  duration_ms: 200_000,
  artists: [{ id: 'a1', name: 'Artist One', uri: 'spotify:artist:a1' }, { id: 'a2', name: 'Artist Two', uri: 'spotify:artist:a2' }],
  album: { id: 'al', name: 'Album', uri: 'spotify:album:al', artists: [], images: [{ url: 'https://i.scdn.co/image/big', width: 640, height: 640 }, { url: 'https://i.scdn.co/image/mid', width: 300, height: 300 }] },
};

describe('parseWebviewMessage', () => {
  it('accepts well-formed messages', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'command', command: 'next' }), { type: 'command', command: 'next' });
    assert.deepEqual(parseWebviewMessage({ type: 'play', uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy' }), {
      type: 'play',
      uri: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy',
    });
    assert.deepEqual(parseWebviewMessage({ type: 'search', requestId: 3, query: 'lofi', kind: 'track', offset: 10 }), {
      type: 'search',
      requestId: 3,
      query: 'lofi',
      kind: 'track',
      offset: 10,
    });
  });

  it('accepts a play request with an album context and rejects bogus contexts', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'play', uri: 'spotify:track:t1', contextUri: 'spotify:album:a1' }), {
      type: 'play',
      uri: 'spotify:track:t1',
      contextUri: 'spotify:album:a1',
    });
    assert.equal(parseWebviewMessage({ type: 'play', uri: 'spotify:track:t1', contextUri: 'spotify:track:t2' }), null);
    assert.equal(parseWebviewMessage({ type: 'play', uri: 'spotify:track:t1', contextUri: 'https://evil.example' }), null);
  });

  it('rejects unknown commands, bad URIs and out-of-range numbers', () => {
    assert.equal(parseWebviewMessage({ type: 'command', command: 'rm -rf' }), null);
    assert.equal(parseWebviewMessage({ type: 'play', uri: 'https://evil.example' }), null);
    assert.equal(parseWebviewMessage({ type: 'play', uri: 'spotify:track:abc&device_id=x' }), null);
    assert.equal(parseWebviewMessage({ type: 'setVolume', percent: 150 }), null);
    assert.equal(parseWebviewMessage({ type: 'seek', positionMs: -1 }), null);
    assert.equal(parseWebviewMessage({ type: 'search', requestId: 1, query: '   ', kind: 'track', offset: 0 }), null);
    assert.equal(parseWebviewMessage({ type: 'search', requestId: 1, query: 'x', kind: 'show', offset: 0 }), null);
    assert.equal(parseWebviewMessage({ type: 'setLiked', uri: 'spotify:track:abc', isLiked: 'yes' }), null);
    assert.equal(parseWebviewMessage(null), null);
    assert.equal(parseWebviewMessage('ready'), null);
  });
});

describe('view models', () => {
  it('picks the smallest image that is still at least 300px wide', () => {
    assert.equal(pickImageUrl(sampleTrack.album.images), 'https://i.scdn.co/image/mid');
    assert.equal(pickImageUrl([]), null);
  });

  it('maps playback state to the now playing view', () => {
    const playback: PlaybackState = {
      device: { id: 'd', name: 'Laptop', type: 'Computer', is_active: true, is_restricted: false, volume_percent: 40, supports_volume: true },
      shuffle_state: true,
      repeat_state: 'context',
      is_playing: true,
      progress_ms: 1234,
      item: sampleTrack,
      context: null,
    };
    const view = toNowPlayingView(playback, 99, new Map([[sampleTrack.uri, true]]));
    assert.deepEqual(view?.track, {
      uri: sampleTrack.uri,
      title: 'Song',
      subtitle: 'Artist One, Artist Two',
      artists: [
        { uri: 'spotify:artist:a1', name: 'Artist One' },
        { uri: 'spotify:artist:a2', name: 'Artist Two' },
      ],
      imageUrl: 'https://i.scdn.co/image/mid',
      durationMs: 200_000,
      isLiked: true,
    });
    assert.equal(view?.volumePercent, 40);
    assert.equal(view?.sampledAt, 99);
    assert.equal(toNowPlayingView(null, 0, new Map()), null);
  });

  it('drops null search entries and carries like state', () => {
    const response: SearchResponse = {
      tracks: { items: [sampleTrack, null], total: 2, limit: 10, offset: 0, next: 'https://next' },
    };
    const results = toSearchResultsView('track', response, new Map([[sampleTrack.uri, false]]));
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].isLiked, false);
    assert.equal(results.items[0].subtitle, 'Artist One, Artist Two · Album');
    assert.deepEqual(results.items[0].artists, [
      { uri: 'spotify:artist:a1', name: 'Artist One' },
      { uri: 'spotify:artist:a2', name: 'Artist Two' },
    ]);
    assert.equal(results.items[0].subtitleDetail, 'Album');
    assert.equal(results.hasMore, true);
    assert.equal(results.items[0].contextUri, 'spotify:album:al');
  });
});

describe('paging helpers', () => {
  it('chunks arrays', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 40), []);
  });

  it('collects pages until there is no next page or the cap is reached', async () => {
    const all = Array.from({ length: 120 }, (_, index) => index);
    const fetchPage = async ({ offset }: { offset: number }) => {
      const items = all.slice(offset, offset + 50);
      return { items, total: all.length, limit: 50, offset, next: offset + 50 < all.length ? 'more' : null };
    };
    assert.equal((await collectPages(fetchPage, 1000)).items.length, 120);
    const capped = await collectPages(fetchPage, 60);
    assert.equal(capped.items.length, 60);
    assert.equal(capped.total, 120);
  });
});

describe('formatDuration', () => {
  it('formats minutes and hours', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(3_725_000), '1:02:05');
  });
});

describe('toArtistLinks', () => {
  it('keeps artists without a Spotify page as plain names', () => {
    // Local files report artists with an empty or non-artist URI.
    const links = toArtistLinks([
      { id: 'a1', name: 'Linked', uri: 'spotify:artist:a1' },
      { id: '', name: 'Local Artist', uri: '' },
      { id: '', name: 'Odd', uri: 'spotify:local:Odd' },
    ]);
    assert.deepEqual(links, [
      { uri: 'spotify:artist:a1', name: 'Linked' },
      { uri: null, name: 'Local Artist' },
      { uri: null, name: 'Odd' },
    ]);
  });
});
