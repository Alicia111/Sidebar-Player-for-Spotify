import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWebviewMessage } from '../src/shared/protocol.ts';
import { toSpotifyWebUrl } from '../src/shared/spotifyLinks.ts';

describe('toSpotifyWebUrl', () => {
  it('maps every linkable kind to its open.spotify.com page', () => {
    assert.equal(toSpotifyWebUrl('spotify:track:4uLU6hMCjMI75M1A2tKUQC'), 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(toSpotifyWebUrl('spotify:album:al'), 'https://open.spotify.com/album/al');
    assert.equal(toSpotifyWebUrl('spotify:artist:a1'), 'https://open.spotify.com/artist/a1');
    assert.equal(toSpotifyWebUrl('spotify:playlist:p1'), 'https://open.spotify.com/playlist/p1');
    assert.equal(toSpotifyWebUrl('spotify:episode:e1'), 'https://open.spotify.com/episode/e1');
  });

  it('has no link for local files or malformed URIs', () => {
    assert.equal(toSpotifyWebUrl('spotify:local:Artist:Album:Song:180'), undefined);
    assert.equal(toSpotifyWebUrl('spotify:track:abc/../../evil'), undefined);
    assert.equal(toSpotifyWebUrl('https://open.spotify.com/track/abc'), undefined);
  });
});

describe('openInSpotify message', () => {
  it('accepts a Spotify URI and rejects anything else', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'openInSpotify', uri: 'spotify:artist:a1' }), { type: 'openInSpotify', uri: 'spotify:artist:a1' });
    assert.equal(parseWebviewMessage({ type: 'openInSpotify', uri: 'https://evil.example' }), null);
    assert.equal(parseWebviewMessage({ type: 'openInSpotify' }), null);
  });
});
