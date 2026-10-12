import type { AlbumView, ArtistHeaderView, SearchItemView } from '../shared/protocol.ts';
import { send } from './bridge.ts';
import { coverImage, h, iconButton, setIcon } from './dom.ts';
import { listenOnSpotifyButton } from './spotifyLink.ts';

export interface ArtistPageOptions {
  onBack: () => void;
  /** Renders one track row, shared with search results so like buttons stay in sync. */
  renderTrack: (item: SearchItemView) => HTMLLIElement;
}

interface AlbumSection {
  toggle: HTMLButtonElement;
  trackList: HTMLUListElement;
  status: HTMLElement;
  isLoaded: boolean;
}

/** An artist's discography: albums and singles, each expandable to its tracks. */
export class ArtistPage {
  readonly element = h('section', { className: 'artist-page' });
  private readonly options: ArtistPageOptions;
  private readonly header = h('div', { className: 'artist-header' });
  private readonly albumList = h('ul', { className: 'album-list' });
  private readonly status = h('div', { className: 'search-status' });
  private readonly loadMoreButton = h('button', { className: 'link-button load-more', text: 'Load more', attributes: { type: 'button' } });
  private readonly albumSections = new Map<string, AlbumSection>();
  /** Which album each pending track request belongs to. */
  private readonly pendingTrackRequests = new Map<number, string>();

  private artistUri: string | undefined;
  private albumsRequestId = 0;
  private nextRequestId = 0;
  private nextOffset = 0;

  constructor(options: ArtistPageOptions) {
    this.options = options;
    this.loadMoreButton.addEventListener('click', () => this.requestAlbums(this.nextOffset));
    this.element.append(this.header, this.status, this.albumList, this.loadMoreButton);
    this.element.hidden = true;
  }

  open(artist: { uri: string; name: string; imageUrl: string | null }): void {
    this.artistUri = artist.uri;
    this.albumSections.clear();
    this.pendingTrackRequests.clear();
    this.albumList.replaceChildren();
    this.loadMoreButton.hidden = true;
    this.renderHeader({ uri: artist.uri, name: artist.name, subtitle: 'Artist', imageUrl: artist.imageUrl });
    this.element.hidden = false;
    this.requestAlbums(0);
  }

  close(): void {
    this.artistUri = undefined;
    this.element.hidden = true;
  }

  showAlbums(message: { requestId: number; offset: number; artist?: ArtistHeaderView; albums: AlbumView[]; hasMore: boolean }): void {
    if (message.requestId !== this.albumsRequestId || !this.artistUri) return;
    if (message.artist) this.renderHeader(message.artist);
    this.albumList.append(...message.albums.map((album) => this.renderAlbum(album)));
    this.nextOffset = message.offset + message.albums.length;
    this.loadMoreButton.hidden = !message.hasMore;
    this.status.textContent = this.albumList.childElementCount === 0 ? 'No albums or singles found.' : '';
  }

  showAlbumTracks(message: { requestId: number; albumUri: string; tracks: SearchItemView[] }): void {
    if (this.pendingTrackRequests.get(message.requestId) !== message.albumUri) return;
    this.pendingTrackRequests.delete(message.requestId);
    const section = this.albumSections.get(message.albumUri);
    if (!section) return;
    section.isLoaded = true;
    section.status.textContent = message.tracks.length === 0 ? 'No playable tracks.' : '';
    section.trackList.replaceChildren(...message.tracks.map((track) => this.options.renderTrack(track)));
  }

  /** Errors are routed by request id: either the album listing or one album's tracks. */
  showError(requestId: number, errorMessage: string): void {
    if (requestId === this.albumsRequestId) {
      this.status.textContent = `Couldn't load albums: ${errorMessage}`;
      return;
    }
    const albumUri = this.pendingTrackRequests.get(requestId);
    if (!albumUri) return;
    this.pendingTrackRequests.delete(requestId);
    const section = this.albumSections.get(albumUri);
    if (section) section.status.textContent = `Couldn't load tracks: ${errorMessage}`;
  }

  private requestAlbums(offset: number): void {
    if (!this.artistUri) return;
    this.albumsRequestId = ++this.nextRequestId;
    if (offset === 0) this.status.textContent = 'Loading discography…';
    send({ type: 'artistAlbums', requestId: this.albumsRequestId, artistUri: this.artistUri, offset });
  }

  private renderHeader(artist: ArtistHeaderView): void {
    const backButton = iconButton({ icon: 'back', label: 'Back to search results', onClick: () => this.options.onBack() });
    const playButton = iconButton({
      icon: 'play',
      label: `Play ${artist.name}`,
      className: 'play-button',
      onClick: () => send({ type: 'play', uri: artist.uri }),
    });
    this.header.replaceChildren(
      backButton,
      coverImage(artist.imageUrl, 'artist-avatar'),
      h('div', { className: 'artist-meta' }, [
        h('div', { className: 'artist-name', text: artist.name, title: artist.name }),
        h('div', { className: 'result-subtitle', text: artist.subtitle }),
      ]),
      ...[listenOnSpotifyButton(artist.uri)].filter((button) => button !== undefined),
      playButton,
    );
  }

  private renderAlbum(album: AlbumView): HTMLLIElement {
    const toggle = iconButton({ icon: 'chevronRight', label: `Show tracks of ${album.title}`, onClick: () => this.toggleAlbum(album.uri) });
    const trackList = h('ul', { className: 'results album-tracks' });
    const status = h('div', { className: 'search-status' });
    trackList.hidden = true;
    status.hidden = true;
    this.albumSections.set(album.uri, { toggle, trackList, status, isLoaded: false });

    const headerRow = h('div', { className: 'result album-row', attributes: { tabindex: '0' } }, [
      toggle,
      coverImage(album.imageUrl, 'thumb'),
      h('div', { className: 'result-meta' }, [
        h('div', { className: 'result-title', text: album.title, title: album.title }),
        h('div', { className: 'result-subtitle', text: album.subtitle, title: album.subtitle }),
      ]),
      h('div', { className: 'result-actions' }, [
        iconButton({ icon: 'play', label: `Play ${album.title}`, onClick: () => send({ type: 'play', uri: album.uri }) }),
        ...[listenOnSpotifyButton(album.uri)].filter((button) => button !== undefined),
      ]),
    ]);
    headerRow.addEventListener('click', () => this.toggleAlbum(album.uri));
    headerRow.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === headerRow) {
        event.preventDefault();
        this.toggleAlbum(album.uri);
      }
    });
    return h('li', { className: 'album' }, [headerRow, status, trackList]);
  }

  private toggleAlbum(albumUri: string): void {
    const section = this.albumSections.get(albumUri);
    if (!section) return;
    const isExpanding = section.trackList.hidden;
    section.trackList.hidden = !isExpanding;
    section.status.hidden = !isExpanding;
    setIcon(section.toggle, isExpanding ? 'expandMore' : 'chevronRight');
    section.toggle.setAttribute('aria-expanded', String(isExpanding));

    if (isExpanding && !section.isLoaded && ![...this.pendingTrackRequests.values()].includes(albumUri)) {
      const requestId = ++this.nextRequestId;
      this.pendingTrackRequests.set(requestId, albumUri);
      section.status.textContent = 'Loading tracks…';
      send({ type: 'albumTracks', requestId, albumUri });
    }
  }
}
