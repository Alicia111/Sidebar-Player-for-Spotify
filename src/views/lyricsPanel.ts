import * as vscode from 'vscode';
import type { SpotifyActions } from '../actions.ts';
import type { LyricsResult } from '../lyrics/lrclib.ts';
import type { LyricsService } from '../lyrics/lyricsService.ts';
import {
  parseLyricsWebviewMessage,
  type LyricsExtensionMessage,
  type LyricsPlaybackView,
  type LyricsTrackView,
  type LyricsView,
  type LyricsWebviewMessage,
} from '../shared/lyricsProtocol.ts';
import type { PlayerState } from '../state/playerState.ts';
import { renderWebviewHtml } from './webviewHtml.ts';

export const LYRICS_PANEL_ID = 'spotifySidebar.lyrics';
const LYRICS_ENABLED_SETTING = 'lyrics.enabled';

/** Editor-area panel that follows the playing track and shows its lyrics from LRCLIB. */
export class LyricsPanelController implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly player: PlayerState;
  private readonly lyrics: LyricsService;
  private readonly actions: SpotifyActions;
  private readonly log: vscode.LogOutputChannel;
  private readonly disposables: vscode.Disposable[] = [];
  private panel: vscode.WebviewPanel | undefined;
  private trackUri: string | undefined;
  private lyricsView: LyricsView = { status: 'idle' };

  constructor(deps: {
    extensionUri: vscode.Uri;
    player: PlayerState;
    lyrics: LyricsService;
    actions: SpotifyActions;
    log: vscode.LogOutputChannel;
  }) {
    this.extensionUri = deps.extensionUri;
    this.player = deps.player;
    this.lyrics = deps.lyrics;
    this.actions = deps.actions;
    this.log = deps.log;

    this.disposables.push(
      this.player.onDidChange(() => this.onPlayerChange()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`spotifySidebar.${LYRICS_ENABLED_SETTING}`)) void this.reloadLyrics();
      }),
    );
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    this.panel = this.createPanel();
    void this.player.refresh();
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private createPanel(): vscode.WebviewPanel {
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      LYRICS_PANEL_ID,
      'Lyrics',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [distUri, mediaUri] },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaUri, 'activitybar.svg');
    panel.webview.html = renderWebviewHtml({
      webview: panel.webview,
      scriptUri: vscode.Uri.joinPath(distUri, 'lyrics.js'),
      styleUri: vscode.Uri.joinPath(mediaUri, 'lyrics.css'),
      title: 'Lyrics',
      allowLocalImages: false,
    });

    const panelDisposables: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw)),
      panel.onDidChangeViewState(() => this.player.setSurfaceVisible(LYRICS_PANEL_ID, panel.visible)),
    ];
    panel.onDidDispose(() => {
      panelDisposables.forEach((disposable) => disposable.dispose());
      this.player.setSurfaceVisible(LYRICS_PANEL_ID, false);
      this.panel = undefined;
      this.trackUri = undefined;
      this.lyricsView = { status: 'idle' };
    });
    this.player.setSurfaceVisible(LYRICS_PANEL_ID, true);
    return panel;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const message = parseLyricsWebviewMessage(raw);
    if (!message) {
      this.log.warn(`Ignoring malformed lyrics panel message: ${JSON.stringify(raw)?.slice(0, 200)}`);
      return;
    }
    await this.dispatch(message);
  }

  private async dispatch(message: LyricsWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postTrack();
        this.postPlayback();
        if (this.lyricsView.status === 'idle') await this.reloadLyrics();
        return;
      case 'seek':
        return this.actions.seek(message.positionMs);
      case 'retry':
        if (this.trackUri) this.lyrics.forget(this.trackUri);
        return this.reloadLyrics();
      case 'enableLyrics':
        await vscode.workspace.getConfiguration('spotifySidebar').update(LYRICS_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
        return;
    }
  }

  private onPlayerChange(): void {
    if (!this.panel) return;
    const uri = this.player.current?.item?.uri;
    if (uri !== this.trackUri) void this.reloadLyrics();
    this.postPlayback();
  }

  private async reloadLyrics(): Promise<void> {
    if (!this.panel) return;
    const item = this.player.current?.item ?? null;
    const requestedUri = item?.uri;
    this.trackUri = requestedUri;

    if (!item) return this.setLyrics({ status: 'idle' });
    if (!isLyricsEnabled()) return this.setLyrics({ status: 'disabled' });
    if (item.type !== 'track') return this.setLyrics({ status: 'unsupported', reason: 'Lyrics are only available for songs, not podcasts.' });

    this.setLyrics({ status: 'loading' });
    try {
      const result = await this.lyrics.getLyrics(item);
      // The track may have changed while LRCLIB was answering.
      if (this.trackUri === requestedUri) this.setLyrics(toLyricsView(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`Fetching lyrics for ${item.uri} failed: ${message}`);
      if (this.trackUri === requestedUri) this.setLyrics({ status: 'error', message });
    }
  }

  private setLyrics(view: LyricsView): void {
    this.lyricsView = view;
    this.postTrack();
  }

  private postTrack(): void {
    const track = this.player.view?.track;
    const trackView: LyricsTrackView | null = track
      ? { uri: track.uri, title: track.title, subtitle: track.subtitle, imageUrl: track.imageUrl }
      : null;
    this.post({ type: 'track', track: trackView, lyrics: this.lyricsView });
  }

  private postPlayback(): void {
    const view = this.player.view;
    const playback: LyricsPlaybackView | null = view
      ? { isPlaying: view.isPlaying, progressMs: view.progressMs, sampledAt: view.sampledAt }
      : null;
    this.post({ type: 'playback', playback });
  }

  private post(message: LyricsExtensionMessage): void {
    void this.panel?.webview.postMessage(message);
  }
}

function isLyricsEnabled(): boolean {
  return vscode.workspace.getConfiguration('spotifySidebar').get<boolean>(LYRICS_ENABLED_SETTING, true);
}

function toLyricsView(result: LyricsResult): LyricsView {
  switch (result.kind) {
    case 'synced':
      return { status: 'synced', lines: result.lines };
    case 'plain':
      return { status: 'plain', text: result.text };
    case 'instrumental':
      return { status: 'instrumental' };
    case 'notFound':
      return { status: 'notFound' };
  }
}
