import type { ExtensionMessage } from '../shared/protocol.ts';
import { send } from './bridge.ts';
import { h } from './dom.ts';
import { PlayerPanel } from './playerPanel.ts';
import { SearchPanel } from './searchPanel.ts';

const app = document.getElementById('app');
if (!app) throw new Error('Now Playing webview is missing its #app root element');

const player = new PlayerPanel();
const search = new SearchPanel();
const loginButton = h('button', { className: 'primary-button', text: 'Log in to Spotify', attributes: { type: 'button' } });
loginButton.addEventListener('click', () => send({ type: 'command', command: 'login' }));
const loginPanel = h('section', { className: 'login' }, [
  h('p', { text: 'Control Spotify from VS Code: playback, search, playlists and likes.' }),
  loginButton,
  h('p', { className: 'hint', text: 'You need a Spotify Premium account and a Client ID from the Spotify Developer Dashboard.' }),
]);
app.append(loginPanel, player.element, search.element);

let hasResumedSearch = false;

function setLoggedIn(isLoggedIn: boolean): void {
  loginPanel.hidden = isLoggedIn;
  player.element.hidden = !isLoggedIn;
  search.element.hidden = !isLoggedIn;
  if (isLoggedIn && !hasResumedSearch) {
    hasResumedSearch = true;
    search.resume();
  }
}

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'session':
      setLoggedIn(message.isLoggedIn);
      return;
    case 'nowPlaying':
      player.update(message.state);
      if (message.state?.track?.isLiked !== undefined) search.updateLike(message.state.track.uri, message.state.track.isLiked);
      return;
    case 'searchResults':
      search.showResults(message.requestId, message.offset, message.results);
      return;
    case 'searchError':
      search.showError(message.requestId, message.message);
      return;
    case 'likeChanged':
      search.updateLike(message.uri, message.isLiked);
      return;
    case 'runSearch':
      search.searchFor(message.query);
      return;
    case 'artistAlbums':
      search.showArtistAlbums(message);
      return;
    case 'albumTracks':
      search.showAlbumTracks(message);
      return;
    case 'browseError':
      search.showBrowseError(message.requestId, message.message);
      return;
  }
});

// Stay blank until the extension reports the session, to avoid flashing the login panel.
for (const section of [loginPanel, player.element, search.element]) section.hidden = true;
send({ type: 'ready' });
