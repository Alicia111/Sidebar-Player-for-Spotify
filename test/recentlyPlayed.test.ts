import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpotifyApi } from '../src/api/endpoints.ts';
import { SpotifyClient } from '../src/api/spotifyClient.ts';
import type { PlayHistory, Track } from '../src/api/types.ts';
import { uniqueRecentTracks } from '../src/state/viewModels.ts';

function track(id: string): Track {
  return {
    type: 'track',
    id,
    name: `Song ${id}`,
    uri: `spotify:track:${id}`,
    duration_ms: 1000,
    artists: [],
    album: { id: 'a', name: 'Album', uri: 'spotify:album:a', images: [], artists: [] },
  };
}

function played(id: string, playedAt: string): PlayHistory {
  return { track: track(id), played_at: playedAt };
}

describe('uniqueRecentTracks', () => {
  it('keeps each track once, at its most recent play', () => {
    const history = [played('t1', '3'), played('t2', '2'), played('t1', '1'), played('t3', '0')];
    assert.deepEqual(uniqueRecentTracks(history).map((entry) => entry.id), ['t1', 't2', 't3']);
  });

  it('returns nothing for an empty history', () => {
    assert.deepEqual(uniqueRecentTracks([]), []);
  });
});

describe('SpotifyApi.getRecentlyPlayed', () => {
  it('asks for the largest page and returns its items', async () => {
    const urls: URL[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return Response.json({ items: [played('t1', '2026-10-16T12:00:00Z')], next: null });
    }) as typeof fetch;
    const tokens = { getAccessToken: async () => 'token', invalidateAccessToken: () => undefined };
    const api = new SpotifyApi(new SpotifyClient({ tokens, fetchFn }));

    const history = await api.getRecentlyPlayed();

    assert.equal(urls[0].pathname, '/v1/me/player/recently-played');
    assert.equal(urls[0].searchParams.get('limit'), '50');
    assert.deepEqual(history.map((entry) => entry.track.id), ['t1']);
  });
});
