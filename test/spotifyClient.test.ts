import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildUrl, SpotifyApiError, SpotifyClient, type TokenProvider } from '../src/api/spotifyClient.ts';

interface FakeTokens extends TokenProvider {
  invalidations: number;
}

function fakeTokens(): FakeTokens {
  let current = 0;
  return {
    invalidations: 0,
    async getAccessToken() {
      return `token-${current}`;
    },
    invalidateAccessToken() {
      this.invalidations++;
      current++;
    },
  };
}

function scriptedFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected extra request to ${String(url)}`);
    return next();
  }) as typeof fetch;
  return { fetchFn, calls };
}

const noSleep = async () => undefined;

describe('SpotifyClient', () => {
  it('sends the bearer token and parses JSON', async () => {
    const { fetchFn, calls } = scriptedFetch([() => Response.json({ id: 'me' })]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: noSleep });

    const body = await client.request<{ id: string }>('GET', '/me');

    assert.deepEqual(body, { id: 'me' });
    assert.equal(calls[0].url, 'https://api.spotify.com/v1/me');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-0');
  });

  it('returns undefined for 204 No Content', async () => {
    const { fetchFn } = scriptedFetch([() => new Response(null, { status: 204 })]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: noSleep });

    assert.equal(await client.request('GET', '/me/player'), undefined);
  });

  it('refreshes the token once after a 401 and retries', async () => {
    const tokens = fakeTokens();
    const { fetchFn, calls } = scriptedFetch([
      () => new Response(null, { status: 401 }),
      () => Response.json({ ok: true }),
    ]);
    const client = new SpotifyClient({ tokens, fetchFn, sleep: noSleep });

    assert.deepEqual(await client.request('GET', '/me'), { ok: true });
    assert.equal(tokens.invalidations, 1);
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, 'Bearer token-1');
  });

  it('does not loop forever on repeated 401s', async () => {
    const { fetchFn } = scriptedFetch([
      () => new Response(null, { status: 401 }),
      () => Response.json({ error: { status: 401, message: 'Invalid token' } }, { status: 401 }),
    ]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: noSleep });

    await assert.rejects(client.request('GET', '/me'), (error: unknown) => error instanceof SpotifyApiError && error.status === 401);
  });

  it('waits for Retry-After on 429 before retrying', async () => {
    const sleeps: number[] = [];
    const { fetchFn } = scriptedFetch([
      () => new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
      () => Response.json({ ok: true }),
    ]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: async (ms) => void sleeps.push(ms) });

    assert.deepEqual(await client.request('GET', '/search'), { ok: true });
    assert.deepEqual(sleeps, [2000]);
  });

  it('gives up immediately when Retry-After is too long', async () => {
    const { fetchFn } = scriptedFetch([() => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } })]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: noSleep });

    await assert.rejects(client.request('GET', '/search'), (error: unknown) => error instanceof SpotifyApiError && error.status === 429);
  });

  it('exposes Spotify error reasons', async () => {
    const { fetchFn } = scriptedFetch([
      () => Response.json({ error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }, { status: 404 }),
    ]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: noSleep });

    await assert.rejects(client.request('PUT', '/me/player/play'), (error: unknown) => {
      assert.ok(error instanceof SpotifyApiError);
      assert.equal(error.reason, 'NO_ACTIVE_DEVICE');
      assert.ok(error.isNoActiveDevice);
      assert.match(error.message, /PUT \/me\/player\/play failed with HTTP 404/);
      return true;
    });
  });

  it('sends JSON bodies with a content type', async () => {
    const { fetchFn, calls } = scriptedFetch([() => new Response(null, { status: 204 })]);
    const client = new SpotifyClient({ tokens: fakeTokens(), fetchFn, sleep: noSleep });

    await client.request('PUT', '/me/player', { body: { device_ids: ['abc'] } });

    assert.equal(calls[0].init?.body, '{"device_ids":["abc"]}');
    assert.equal((calls[0].init?.headers as Record<string, string>)['Content-Type'], 'application/json');
  });
});

describe('buildUrl', () => {
  it('encodes query values and skips undefined ones', () => {
    const url = buildUrl('/search', { q: 'lo-fi & chill', type: 'track', offset: undefined, limit: 10 });
    assert.equal(url, 'https://api.spotify.com/v1/search?q=lo-fi+%26+chill&type=track&limit=10');
  });
});
