import * as vscode from 'vscode';
import { SpotifyActions } from './actions.ts';
import { SpotifyApi } from './api/endpoints.ts';
import { SpotifyClient } from './api/spotifyClient.ts';
import { AuthManager } from './auth/authManager.ts';
import { registerCommands } from './commands.ts';
import { LyricsService } from './lyrics/lyricsService.ts';
import { PlayerState } from './state/playerState.ts';
import { DeviceTreeProvider } from './views/deviceTree.ts';
import { LyricsPanelController } from './views/lyricsPanel.ts';
import { NOW_PLAYING_VIEW_ID, NowPlayingViewProvider } from './views/nowPlayingView.ts';
import { PlaylistTreeProvider } from './views/playlistTree.ts';
import { QUEUE_VIEW_ID, QueueTreeProvider } from './views/queueTree.ts';
import { StatusBarController } from './views/statusBar.ts';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Spotify', { log: true });
  const auth = new AuthManager(context.secrets, log);
  const api = new SpotifyApi(new SpotifyClient({ tokens: auth }));
  const player = new PlayerState(api, auth, log);
  const actions = new SpotifyActions({ api, auth, player, log, memento: context.globalState, extensionUri: context.extensionUri });

  const nowPlaying = new NowPlayingViewProvider({ extensionUri: context.extensionUri, api, auth, player, actions, log });
  const playlists = new PlaylistTreeProvider(api, actions);
  const devices = new DeviceTreeProvider(api, actions);
  const queue = new QueueTreeProvider(api, player, actions);
  const queueView = vscode.window.createTreeView(QUEUE_VIEW_ID, { treeDataProvider: queue });
  queue.attach(queueView);
  const lyrics = new LyricsPanelController({ extensionUri: context.extensionUri, player, lyrics: new LyricsService(), actions, log });

  context.subscriptions.push(
    log,
    auth,
    player,
    actions,
    nowPlaying,
    playlists,
    devices,
    queue,
    queueView,
    lyrics,
    new StatusBarController(player, auth),
    vscode.window.registerWebviewViewProvider(NOW_PLAYING_VIEW_ID, nowPlaying),
    vscode.window.registerTreeDataProvider('spotifySidebar.playlists', playlists),
    vscode.window.registerTreeDataProvider('spotifySidebar.devices', devices),
    auth.onDidChangeLoginState(() => {
      playlists.refresh();
      devices.refresh();
      queue.refresh();
    }),
    ...registerCommands({ actions, nowPlaying, playlists, devices, lyrics, queue }),
  );

  await auth.initialize();
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
