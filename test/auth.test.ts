import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildRedirectUri, listenForAuthCode, LoginCancelledError, parseCallback } from '../src/auth/loopbackServer.ts';
import { buildAuthorizeUrl, refreshAccessToken, TokenRequestError } from '../src/auth/oauth.ts';
import { createCodeChallenge, createCodeVerifier, createState } from '../src/auth/pkce.ts';

describe('PKCE', () => {
  it('creates a verifier within RFC 7636 length and charset', () => {
    const verifier = createCodeVerifier();
    assert.match(verifier, /^[A-Za-z0-9\-_]{43,128}$/);
  });

  it('derives the S256 challenge from the verifier', () => {
    const verifier = createCodeVerifier();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    assert.equal(createCodeChallenge(verifier), expected);
  });

  it('creates distinct states', () => {
    assert.notEqual(createState(), createState());
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes PKCE parameters and the redirect URI', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'abc', redirectUri: buildRedirectUri(8888), codeChallenge: 'xyz', state: 's1' }));
    assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), 'xyz');
    assert.equal(url.searchParams.get('state'), 's1');
    assert.match(url.searchParams.get('scope') ?? '', /user-modify-playback-state/);
  });
});

describe('refreshAccessToken', () => {
  it('keeps the old refresh token when Spotify does not rotate it', async () => {
    const fetchFn = (async () => Response.json({ access_token: 'new-access', expires_in: 3600 })) as typeof fetch;
    const tokens = await refreshAccessToken('client', 'old-refresh', fetchFn);
    assert.equal(tokens.accessToken, 'new-access');
    assert.equal(tokens.refreshToken, 'old-refresh');
    assert.ok(tokens.expiresAt > Date.now());
  });

  it('surfaces invalid_grant as a typed error', async () => {
    const fetchFn = (async () =>
      Response.json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, { status: 400 })) as typeof fetch;
    await assert.rejects(refreshAccessToken('client', 'old-refresh', fetchFn), (error: unknown) => {
      assert.ok(error instanceof TokenRequestError);
      assert.equal(error.errorCode, 'invalid_grant');
      return true;
    });
  });
});

describe('parseCallback', () => {
  it('accepts a matching state with a code', () => {
    assert.deepEqual(parseCallback(new URLSearchParams('code=abc&state=s1'), 's1'), { ok: true, code: 'abc' });
  });

  it('treats a mismatched or missing state as a foreign request', () => {
    assert.deepEqual(parseCallback(new URLSearchParams('code=abc&state=evil'), 's1'), { foreign: true });
    assert.deepEqual(parseCallback(new URLSearchParams('error=access_denied'), 's1'), { foreign: true });
  });

  it('reports access_denied', () => {
    const result = parseCallback(new URLSearchParams('error=access_denied&state=s1'), 's1');
    assert.deepEqual(result, { ok: false, reason: 'Spotify returned "access_denied"' });
  });
});

describe('listenForAuthCode', () => {
  const port = 38000 + Math.floor(Math.random() * 1000);

  it('resolves with the code delivered to the loopback callback', async () => {
    const listener = await listenForAuthCode({ port, expectedState: 's1', timeoutMs: 5000 });
    const response = await fetch(`${buildRedirectUri(port)}?code=the-code&state=s1`);
    assert.equal(response.status, 200);
    assert.equal(await listener.code, 'the-code');
  });

  it('ignores unrelated paths and rejects on cancel', async () => {
    const listener = await listenForAuthCode({ port: port + 1, expectedState: 's1', timeoutMs: 5000 });
    const response = await fetch(`http://127.0.0.1:${port + 1}/favicon.ico`);
    assert.equal(response.status, 404);
    listener.dispose();
    await assert.rejects(listener.code, LoginCancelledError);
  });

  it('keeps waiting when a foreign request without our state hits the callback', async () => {
    const listener = await listenForAuthCode({ port: port + 3, expectedState: 's1', timeoutMs: 5000 });
    const forged = await fetch(`${buildRedirectUri(port + 3)}?error=access_denied&state=guess`);
    assert.equal(forged.status, 400);
    const genuine = await fetch(`${buildRedirectUri(port + 3)}?code=real&state=s1`);
    assert.equal(genuine.status, 200);
    assert.equal(await listener.code, 'real');
  });

  it('does not reflect query parameters into the response page', async () => {
    const listener = await listenForAuthCode({ port: port + 2, expectedState: 's1', timeoutMs: 5000 });
    const response = await fetch(`${buildRedirectUri(port + 2)}?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=s1`);
    assert.doesNotMatch(await response.text(), /<script>/);
    await assert.rejects(listener.code);
  });
});
