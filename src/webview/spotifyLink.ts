import { LISTEN_ON_SPOTIFY_LABEL, toSpotifyWebUrl } from '../shared/spotifyLinks.ts';
import { send } from './bridge.ts';
import { iconButton } from './dom.ts';

/** Link back to the item on Spotify; undefined for items without a Spotify page, such as local files. */
export function listenOnSpotifyButton(uri: string): HTMLButtonElement | undefined {
  if (!toSpotifyWebUrl(uri)) return undefined;
  return iconButton({ icon: 'openExternal', label: LISTEN_ON_SPOTIFY_LABEL, onClick: () => send({ type: 'openInSpotify', uri }) });
}
