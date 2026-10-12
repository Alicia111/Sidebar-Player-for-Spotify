// Spotify's terms ask that content shown from the API links back to Spotify; these are those links.
// Shared by the extension and the webview, so it must stay free of `vscode` and DOM imports.

const WEB_PLAYER_BASE_URL = 'https://open.spotify.com';
const LINKABLE_URI_PATTERN = /^spotify:(track|album|artist|playlist|episode):([A-Za-z0-9]{1,64})$/;

/** Button label wording from Spotify's design guidelines. */
export const LISTEN_ON_SPOTIFY_LABEL = 'Listen on Spotify';

/** `spotify:track:abc` → `https://open.spotify.com/track/abc`; undefined for local files and unknown kinds. */
export function toSpotifyWebUrl(uri: string): string | undefined {
  const match = LINKABLE_URI_PATTERN.exec(uri);
  return match ? `${WEB_PLAYER_BASE_URL}/${match[1]}/${match[2]}` : undefined;
}
