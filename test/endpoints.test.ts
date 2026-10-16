import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpotifyApi } from '../src/api/endpoints.ts';
import { SpotifyClient } from '../src/api/spotifyClient.ts';

function apiWith(respond: (url: URL, init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  const tokens = { getAccessToken: async () => 'token', invalidateAccessToken: () => undefined };
  return { api: new SpotifyApi(new SpotifyClient({ tokens, fetchFn })), calls };
}

describe('SpotifyApi.play', () => {
  it('prefers an offset URI over a position', async () => {
    const { api, calls } = apiWith(() => new Response(null, { status: 204 }));
    await api.play({ contextUri: 'spotify:playlist:p1', offsetUri: 'spotify:track:t2', offsetPosition: 5 });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      context_uri: 'spotify:playlist:p1',
      offset: { uri: 'spotify:track:t2' },
    });
  });

  it('sends no body when resuming', async () => {
    const { api, calls } = apiWith(() => new Response(null, { status: 204 }));
    await api.play();
    assert.equal(calls[0].init?.body, undefined);
  });
});

describe('SpotifyApi.getQueue', () => {
  it('normalises an empty response', async () => {
    const { api } = apiWith(() => new Response(null, { status: 204 }));
    assert.deepEqual(await api.getQueue(), { currently_playing: null, queue: [] });
  });
});

describe('SpotifyApi.getContextName', () => {
  it('names Liked Songs without a request', async () => {
    const { api, calls } = apiWith(() => Response.json({}));
    assert.equal(await api.getContextName('spotify:user:someone:collection'), 'Liked Songs');
    assert.equal(calls.length, 0);
  });

  it('asks only for the playlist name', async () => {
    const { api, calls } = apiWith(() => Response.json({ name: 'Focus Mix' }));
    assert.equal(await api.getContextName('spotify:playlist:abc123'), 'Focus Mix');
    assert.equal(calls[0].url.pathname, '/v1/playlists/abc123');
    assert.equal(calls[0].url.searchParams.get('fields'), 'name');
  });

  it('returns undefined for unsupported context types', async () => {
    const { api, calls } = apiWith(() => Response.json({}));
    assert.equal(await api.getContextName('spotify:station:xyz'), undefined);
    assert.equal(calls.length, 0);
  });
});

describe('SpotifyApi.removeItemsFromPlaylist', () => {
  it('sends URIs as item objects, at most 100 per request', async () => {
    const { api, calls } = apiWith(() => Response.json({ snapshot_id: 'abc' }));
    const uris = Array.from({ length: 101 }, (_, index) => `spotify:track:t${index}`);
    await api.removeItemsFromPlaylist('p1', uris);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].init?.method, 'DELETE');
    assert.equal(calls[0].url.pathname, '/v1/playlists/p1/items');
    const firstBody = JSON.parse(String(calls[0].init?.body));
    assert.equal(firstBody.items.length, 100);
    assert.deepEqual(firstBody.items[0], { uri: 'spotify:track:t0' });
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { items: [{ uri: 'spotify:track:t100' }] });
  });
});
