import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { describeError, type SpotifyActions } from '../actions.ts';
import type { SpotifyApi } from '../api/endpoints.ts';
import type { SearchResponse } from '../api/types.ts';
import type { AuthManager } from '../auth/authManager.ts';
import {
  parseWebviewMessage,
  type ExtensionMessage,
  type PlayerCommand,
  type SearchKind,
  type WebviewMessage,
} from '../shared/protocol.ts';
import type { PlayerState } from '../state/playerState.ts';
import { toSearchResultsView } from '../state/viewModels.ts';

export const NOW_PLAYING_VIEW_ID = 'spotifySidebar.nowPlaying';
// Spotify serves cover art from these CDNs.
const IMAGE_SOURCES = 'https://i.scdn.co https://*.scdn.co https://*.spotifycdn.com';

export class NowPlayingViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly api: SpotifyApi;
  private readonly auth: AuthManager;
  private readonly player: PlayerState;
  private readonly actions: SpotifyActions;
  private readonly log: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private pendingSearchQuery: string | undefined;

  constructor(deps: {
    extensionUri: vscode.Uri;
    api: SpotifyApi;
    auth: AuthManager;
    player: PlayerState;
    actions: SpotifyActions;
    log: vscode.LogOutputChannel;
  }) {
    this.extensionUri = deps.extensionUri;
    this.api = deps.api;
    this.auth = deps.auth;
    this.player = deps.player;
    this.actions = deps.actions;
    this.log = deps.log;

    this.disposables.push(
      this.player.onDidChange(() => this.postNowPlaying()),
      this.auth.onDidChangeLoginState((isLoggedIn) => this.post({ type: 'session', isLoggedIn })),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri, mediaUri] };
    view.webview.html = this.renderHtml(view.webview, distUri, mediaUri);

    view.onDidChangeVisibility(() => this.player.setSurfaceVisible(NOW_PLAYING_VIEW_ID, view.visible), undefined, this.disposables);
    view.onDidDispose(() => {
      this.view = undefined;
      this.player.setSurfaceVisible(NOW_PLAYING_VIEW_ID, false);
    }, undefined, this.disposables);
    view.webview.onDidReceiveMessage((raw) => this.handleMessage(raw), undefined, this.disposables);
    this.player.setSurfaceVisible(NOW_PLAYING_VIEW_ID, view.visible);
  }

  /** Opens the sidebar and runs a search there (used by the "Spotify: Search" command). */
  async startSearch(query: string): Promise<void> {
    this.pendingSearchQuery = query;
    await vscode.commands.executeCommand(`${NOW_PLAYING_VIEW_ID}.focus`);
    // If the view already exists it won't send "ready" again, so deliver the query now.
    if (this.view) this.flushPendingSearch();
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.log.warn(`Ignoring malformed webview message: ${JSON.stringify(raw)?.slice(0, 200)}`);
      return;
    }
    await this.dispatch(message);
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'session', isLoggedIn: this.auth.isLoggedIn });
        this.postNowPlaying();
        this.flushPendingSearch();
        return;
      case 'command':
        return this.runPlayerCommand(message.command);
      case 'seek':
        return this.actions.seek(message.positionMs);
      case 'setVolume':
        return this.actions.setVolume(message.percent);
      case 'search':
        return this.search(message.requestId, message.query, message.kind, message.offset);
      case 'play':
        return this.actions.playUri(message.uri, message.contextUri);
      case 'queue':
        return this.actions.addToQueue(message.uri);
      case 'setLiked':
        await this.actions.setLiked(message.uri, message.isLiked);
        this.post({ type: 'likeChanged', uri: message.uri, isLiked: this.player.getLiked(message.uri) ?? !message.isLiked });
        return;
      case 'addToPlaylist':
        return this.actions.addToPlaylist(message.uri);
    }
  }

  private async runPlayerCommand(command: PlayerCommand): Promise<void> {
    switch (command) {
      case 'login':
        return this.actions.login();
      case 'playPause':
        return this.actions.playPause();
      case 'next':
        return this.actions.next();
      case 'previous':
        return this.actions.previous();
      case 'toggleShuffle':
        return this.actions.toggleShuffle();
      case 'cycleRepeat':
        return this.actions.cycleRepeat();
      case 'toggleLikeCurrent':
        return this.actions.toggleLikeCurrent();
      case 'selectDevice':
        return this.actions.selectDevice();
      case 'showLyrics':
        await vscode.commands.executeCommand('spotifySidebar.showLyrics');
        return;
    }
  }

  private async search(requestId: number, query: string, kind: SearchKind, offset: number): Promise<void> {
    try {
      const response = await this.api.search(query, kind, { offset });
      const likedState = await this.lookUpLikedTracks(response);
      this.post({ type: 'searchResults', requestId, offset, results: toSearchResultsView(kind, response, likedState) });
    } catch (error) {
      this.log.warn(`Search "${query}" (${kind}) failed: ${describeError(error)}`);
      this.post({ type: 'searchError', requestId, message: describeError(error) });
    }
  }

  /** Like state is a nice-to-have on search results; failure just leaves hearts unknown. */
  private async lookUpLikedTracks(response: SearchResponse): Promise<Map<string, boolean>> {
    const uris = (response.tracks?.items ?? []).flatMap((track) => (track && !track.is_local ? [track.uri] : []));
    if (uris.length === 0) return new Map();
    try {
      const likedState = await this.api.libraryContains(uris);
      likedState.forEach((isLiked, uri) => this.player.setLiked(uri, isLiked));
      return likedState;
    } catch (error) {
      this.log.warn(`Checking liked state for search results failed: ${describeError(error)}`);
      return new Map();
    }
  }

  private flushPendingSearch(): void {
    if (this.pendingSearchQuery === undefined) return;
    this.post({ type: 'runSearch', query: this.pendingSearchQuery });
    this.pendingSearchQuery = undefined;
  }

  private postNowPlaying(): void {
    this.post({ type: 'nowPlaying', state: this.player.view });
  }

  private post(message: ExtensionMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview, distUri: vscode.Uri, mediaUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'nowPlaying.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${IMAGE_SOURCES} ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Now Playing</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
