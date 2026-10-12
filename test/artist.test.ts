import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpotifyApi } from '../src/api/endpoints.ts';
import { SpotifyClient } from '../src/api/spotifyClient.ts';
import type { Artist, ArtistAlbum, SimplifiedTrack } from '../src/api/types.ts';
import { parseWebviewMessage } from '../src/shared/protocol.ts';
import { toAlbumTrackViews, toAlbumView, toArtistHeaderView } from '../src/state/viewModels.ts';

// Placeholder catalogue data, not real artists or releases.
const artist: Artist = {
  id: 'ar1',
  name: 'Test Artist',
  uri: 'spotify:artist:ar1',
  genres: ['genre one', 'genre two', 'genre three', 'genre four'],
  images: [{ url: 'https://i.scdn.co/image/avatar', width: 320, height: 320 }],
};

const album: ArtistAlbum = {
  id: 'al1',
  name: 'First Record',
  uri: 'spotify:album:al1',
  album_type: 'single',
  total_tracks: 1,
  release_date: '2024-05-01',
  artists: [],
  images: [],
};

const tracks: SimplifiedTrack[] = [
  {
    type: 'track',
    id: 't1',
    name: 'Opening',
    uri: 'spotify:track:t1',
    duration_ms: 90_000,
    artists: [{ id: 'ar1', name: 'Test Artist', uri: 'spotify:artist:ar1' }, { id: 'ar2', name: 'Guest', uri: 'spotify:artist:ar2' }],
    track_number: 1,
    disc_number: 1,
  },
];

describe('artist view models', () => {
  it('builds the header with up to three genres', () => {
    assert.deepEqual(toArtistHeaderView(artist), {
      uri: 'spotify:artist:ar1',
      name: 'Test Artist',
      subtitle: 'genre one, genre two, genre three',
      imageUrl: 'https://i.scdn.co/image/avatar',
    });
    assert.equal(toArtistHeaderView({ ...artist, genres: [] }).subtitle, 'Artist');
  });

  it('describes an album with its type, year and track count', () => {
    assert.equal(toAlbumView(album).subtitle, 'Single · 2024 · 1 track');
    assert.equal(toAlbumView({ ...album, album_type: 'album', total_tracks: 12 }).subtitle, 'Album · 2024 · 12 tracks');
  });

  it('maps album tracks to playable rows inside the album context', () => {
    const [row] = toAlbumTrackViews(tracks, album.uri, new Map([['spotify:track:t1', true]]));
    assert.deepEqual(row, {
      uri: 'spotify:track:t1',
      kind: 'track',
      title: 'Opening',
      subtitle: 'Test Artist, Guest',
      imageUrl: null,
      durationMs: 90_000,
      isLiked: true,
      contextUri: 'spotify:album:al1',
    });
  });
});

describe('artist browsing messages', () => {
  it('accepts artist and album requests', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'artistAlbums', requestId: 1, artistUri: 'spotify:artist:ar1', offset: 10 }), {
      type: 'artistAlbums',
      requestId: 1,
      artistUri: 'spotify:artist:ar1',
      offset: 10,
    });
    assert.deepEqual(parseWebviewMessage({ type: 'albumTracks', requestId: 2, albumUri: 'spotify:album:al1' }), {
      type: 'albumTracks',
      requestId: 2,
      albumUri: 'spotify:album:al1',
    });
  });

  it('rejects mismatched URI types and bad offsets', () => {
    assert.equal(parseWebviewMessage({ type: 'artistAlbums', requestId: 1, artistUri: 'spotify:album:al1', offset: 0 }), null);
    assert.equal(parseWebviewMessage({ type: 'artistAlbums', requestId: 1, artistUri: 'spotify:artist:ar1', offset: -10 }), null);
    assert.equal(parseWebviewMessage({ type: 'albumTracks', requestId: 1, albumUri: 'spotify:artist:ar1' }), null);
    assert.equal(parseWebviewMessage({ type: 'albumTracks', requestId: 1, albumUri: 'spotify:album:../../me' }), null);
  });
});

describe('artist endpoints', () => {
  function apiRecording() {
    const urls: URL[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return Response.json({ items: [], total: 0, limit: 10, offset: 0, next: null });
    }) as typeof fetch;
    const tokens = { getAccessToken: async () => 'token', invalidateAccessToken: () => undefined };
    return { api: new SpotifyApi(new SpotifyClient({ tokens, fetchFn })), urls };
  }

  it('asks for albums and singles only, within the 10-per-page cap', async () => {
    const { api, urls } = apiRecording();
    await api.getArtistAlbums('ar1', { offset: 20 });
    assert.equal(urls[0].pathname, '/v1/artists/ar1/albums');
    assert.equal(urls[0].searchParams.get('include_groups'), 'album,single');
    assert.equal(urls[0].searchParams.get('limit'), '10');
    assert.equal(urls[0].searchParams.get('offset'), '20');
  });

  it('pages album tracks 50 at a time', async () => {
    const { api, urls } = apiRecording();
    await api.getAlbumTracks('al1', { offset: 0 });
    assert.equal(urls[0].pathname, '/v1/albums/al1/tracks');
    assert.equal(urls[0].searchParams.get('limit'), '50');
  });
});
