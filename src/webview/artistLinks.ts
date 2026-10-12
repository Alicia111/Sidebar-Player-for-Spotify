import type { ArtistLinkView } from '../shared/protocol.ts';
import { h } from './dom.ts';

export type OpenArtist = (artist: { uri: string; name: string }) => void;

/** Appends "Artist A, Artist B" to `line`; names with a Spotify page become links that open that artist. */
export function appendArtistCredits(line: HTMLElement, artists: readonly ArtistLinkView[], onOpen: OpenArtist): void {
  artists.forEach((artist, index) => {
    if (index > 0) line.append(', ');
    line.append(artist.uri ? artistLink(artist.uri, artist.name, onOpen) : artist.name);
  });
}

function artistLink(uri: string, name: string, onOpen: OpenArtist): HTMLButtonElement {
  const link = h('button', { className: 'link-button artist-link', text: name, title: `Show all songs by ${name}`, attributes: { type: 'button' } });
  link.addEventListener('click', (event) => {
    event.stopPropagation();
    onOpen({ uri, name });
  });
  // A double-click on a result row plays the track; on an artist name it should only open the artist.
  link.addEventListener('dblclick', (event) => event.stopPropagation());
  return link;
}
