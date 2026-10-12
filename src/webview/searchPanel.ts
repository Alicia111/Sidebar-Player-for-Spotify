import { formatDuration } from '../shared/format.ts';
import {
  SEARCH_KINDS,
  type AlbumView,
  type ArtistHeaderView,
  type SearchItemView,
  type SearchKind,
  type SearchResultsView,
} from '../shared/protocol.ts';
import { ArtistPage } from './artistPage.ts';
import { loadState, saveState, send } from './bridge.ts';
import { coverImage, h, icon, iconButton, setIcon } from './dom.ts';
import { listenOnSpotifyButton } from './spotifyLink.ts';

const SEARCH_DEBOUNCE_MS = 350;
const KIND_LABELS: Record<SearchKind, string> = { track: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists' };

/** Search box, type tabs and a paged result list. */
export class SearchPanel {
  readonly element = h('section', { className: 'search' });
  private readonly input = h('input', {
    className: 'search-input',
    attributes: { type: 'search', placeholder: 'Search songs, albums, artists…', 'aria-label': 'Search Spotify', maxlength: '200' },
  });
  private readonly tabs = h('div', { className: 'tabs', attributes: { role: 'tablist' } });
  private readonly results = h('ul', { className: 'results' });
  private readonly status = h('div', { className: 'search-status' });
  private readonly loadMoreButton = h('button', { className: 'link-button load-more', text: 'Load more', attributes: { type: 'button' } });
  /** Wraps tabs and results so the artist page can take their place. */
  private readonly resultsSection = h('div', { className: 'search-results' });
  private readonly artistPage = new ArtistPage({
    onBack: () => this.closeArtist(),
    renderTrack: (item) => this.renderItem(item),
  });

  private kind: SearchKind = 'track';
  private latestRequestId = 0;
  private nextOffset = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const restored = loadState();
    if (restored) {
      this.input.value = restored.query;
      this.kind = restored.kind;
    }

    for (const kind of SEARCH_KINDS) {
      const tab = h('button', { className: 'tab', text: KIND_LABELS[kind], attributes: { type: 'button', role: 'tab', 'data-kind': kind } });
      tab.addEventListener('click', () => this.selectKind(kind));
      this.tabs.append(tab);
    }
    this.input.addEventListener('input', () => this.scheduleSearch());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.runSearch(0);
    });
    this.loadMoreButton.addEventListener('click', () => this.runSearch(this.nextOffset));

    this.resultsSection.append(this.tabs, this.status, this.results, this.loadMoreButton);
    this.element.append(h('div', { className: 'search-box' }, [icon('search'), this.input]), this.resultsSection, this.artistPage.element);
    this.renderTabs();
    this.loadMoreButton.hidden = true;
  }

  /** Re-runs the restored query once the extension is ready to answer. */
  resume(): void {
    if (this.input.value.trim()) this.runSearch(0);
  }

  searchFor(query: string): void {
    this.input.value = query;
    this.input.focus();
    this.runSearch(0);
  }

  showResults(requestId: number, offset: number, results: SearchResultsView): void {
    if (requestId !== this.latestRequestId) return;
    if (offset === 0) this.results.replaceChildren();
    this.results.append(...results.items.map((item) => this.renderItem(item)));
    this.nextOffset = offset + results.items.length;
    this.loadMoreButton.hidden = !results.hasMore;
    this.status.textContent = this.results.childElementCount === 0 ? 'No results.' : '';
  }

  showError(requestId: number, message: string): void {
    if (requestId !== this.latestRequestId) return;
    this.status.textContent = `Search failed: ${message}`;
  }

  /** The same track can be listed in search results and in an artist's album at once; update every copy. */
  updateLike(uri: string, isLiked: boolean): void {
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('button[data-like-uri]')) {
      if (button.dataset.likeUri === uri) renderLikeButton(button, isLiked);
    }
  }

  showArtistAlbums(message: { requestId: number; offset: number; artist?: ArtistHeaderView; albums: AlbumView[]; hasMore: boolean }): void {
    this.artistPage.showAlbums(message);
  }

  showAlbumTracks(message: { requestId: number; albumUri: string; tracks: SearchItemView[] }): void {
    this.artistPage.showAlbumTracks(message);
  }

  showBrowseError(requestId: number, message: string): void {
    this.artistPage.showError(requestId, message);
  }

  private openArtist(item: SearchItemView): void {
    this.resultsSection.hidden = true;
    this.artistPage.open({ uri: item.uri, name: item.title, imageUrl: item.imageUrl });
  }

  private closeArtist(): void {
    this.artistPage.close();
    this.resultsSection.hidden = false;
  }

  private selectKind(kind: SearchKind): void {
    if (kind === this.kind) return;
    this.kind = kind;
    this.renderTabs();
    this.runSearch(0);
  }

  private renderTabs(): void {
    for (const tab of this.tabs.querySelectorAll<HTMLButtonElement>('.tab')) {
      const isSelected = tab.dataset.kind === this.kind;
      tab.classList.toggle('is-selected', isSelected);
      tab.setAttribute('aria-selected', String(isSelected));
    }
  }

  private scheduleSearch(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.runSearch(0), SEARCH_DEBOUNCE_MS);
  }

  private runSearch(offset: number): void {
    clearTimeout(this.debounceTimer);
    const query = this.input.value.trim();
    saveState({ query, kind: this.kind });
    this.latestRequestId++;
    if (offset === 0) this.closeArtist();

    if (!query) {
      this.results.replaceChildren();
      this.status.textContent = '';
      this.loadMoreButton.hidden = true;
      return;
    }
    if (offset === 0) this.status.textContent = 'Searching…';
    send({ type: 'search', requestId: this.latestRequestId, query, kind: this.kind, offset });
  }

  private renderItem(item: SearchItemView): HTMLLIElement {
    const actions = h('div', { className: 'result-actions' }, [
      iconButton({ icon: 'play', label: 'Play', onClick: () => playItem(item) }),
    ]);
    if (item.kind === 'track') {
      actions.append(
        iconButton({ icon: 'queue', label: 'Add to queue', onClick: () => send({ type: 'queue', uri: item.uri }) }),
        iconButton({ icon: 'playlistAdd', label: 'Add to playlist…', onClick: () => send({ type: 'addToPlaylist', uri: item.uri }) }),
        this.createLikeButton(item),
      );
    }
    const spotifyLink = listenOnSpotifyButton(item.uri);
    if (spotifyLink) actions.append(spotifyLink);

    const subtitle = item.durationMs === undefined ? item.subtitle : `${item.subtitle} · ${formatDuration(item.durationMs)}`;
    const row = h('li', { className: `result kind-${item.kind}`, attributes: { tabindex: '0' } }, [
      coverImage(item.imageUrl, 'thumb'),
      h('div', { className: 'result-meta' }, [
        h('div', { className: 'result-title', text: item.title, title: item.title }),
        h('div', { className: 'result-subtitle', text: subtitle, title: subtitle }),
      ]),
      actions,
    ]);
    // Artists open their discography; everything else plays on double-click or Enter.
    const activate = item.kind === 'artist' ? () => this.openArtist(item) : () => playItem(item);
    if (item.kind === 'artist') {
      row.classList.add('is-browsable');
      row.title = `Show all songs by ${item.title}`;
      row.addEventListener('click', activate);
    } else {
      row.addEventListener('dblclick', activate);
    }
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === row) activate();
    });
    return row;
  }

  private createLikeButton(item: SearchItemView): HTMLButtonElement {
    const button = iconButton({
      icon: 'heart',
      label: 'Save to Liked Songs',
      onClick: () => send({ type: 'setLiked', uri: item.uri, isLiked: button.dataset.liked !== 'true' }),
    });
    button.dataset.likeUri = item.uri;
    renderLikeButton(button, item.isLiked === true);
    return button;
  }
}

function playItem(item: SearchItemView): void {
  send({ type: 'play', uri: item.uri, contextUri: item.contextUri });
}

function renderLikeButton(button: HTMLButtonElement, isLiked: boolean): void {
  button.dataset.liked = String(isLiked);
  setIcon(button, isLiked ? 'heartFilled' : 'heart');
  button.classList.toggle('is-active', isLiked);
  button.title = isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
  button.setAttribute('aria-label', button.title);
}
