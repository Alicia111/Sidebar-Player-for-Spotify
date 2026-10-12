import * as vscode from 'vscode';
import type { SpotifyActions } from './actions.ts';
import type { DeviceTreeNode, DeviceTreeProvider } from './views/deviceTree.ts';
import type { LyricsPanelController } from './views/lyricsPanel.ts';
import type { NowPlayingViewProvider } from './views/nowPlayingView.ts';
import type { PlaylistTreeNode, PlaylistTreeProvider } from './views/playlistTree.ts';
import type { QueueTreeNode, QueueTreeProvider } from './views/queueTree.ts';

/** Tree nodes from any view that represent a single playable item. */
type ItemNode = PlaylistTreeNode | QueueTreeNode;

export interface CommandTargets {
  actions: SpotifyActions;
  nowPlaying: NowPlayingViewProvider;
  playlists: PlaylistTreeProvider;
  devices: DeviceTreeProvider;
  lyrics: LyricsPanelController;
  queue: QueueTreeProvider;
}

export function registerCommands({ actions, nowPlaying, playlists, devices, lyrics, queue }: CommandTargets): vscode.Disposable[] {
  const handlers: Record<string, (...args: never[]) => unknown> = {
    'spotifySidebar.login': () => actions.login(),
    'spotifySidebar.logout': () => actions.logout(),
    'spotifySidebar.playPause': () => actions.playPause(),
    'spotifySidebar.next': () => actions.next(),
    'spotifySidebar.previous': () => actions.previous(),
    'spotifySidebar.toggleShuffle': () => actions.toggleShuffle(),
    'spotifySidebar.cycleRepeat': () => actions.cycleRepeat(),
    'spotifySidebar.toggleLike': () => actions.toggleLikeCurrent(),
    'spotifySidebar.search': () => promptSearch(nowPlaying),
    'spotifySidebar.showLyrics': () => lyrics.show(),
    'spotifySidebar.selectDevice': () => actions.selectDevice(),
    'spotifySidebar.addCurrentToPlaylist': () => actions.addCurrentToPlaylist(),
    'spotifySidebar.createPlaylist': () => actions.createPlaylist(),
    'spotifySidebar.refreshPlaylists': () => playlists.refresh(),
    'spotifySidebar.refreshDevices': () => devices.refresh(),
    'spotifySidebar.refreshQueue': () => queue.refresh(),
    'spotifySidebar.playQueueItem': (node: QueueTreeNode) =>
      node?.kind === 'track' ? actions.playFromQueue(node.item, node.contextUri) : undefined,
    'spotifySidebar.playItem': (node: PlaylistTreeNode) => playlists.playNode(node),
    'spotifySidebar.queueItem': (node: ItemNode) => withTrackUri(node, (uri) => actions.addToQueue(uri)),
    'spotifySidebar.toggleLikeItem': (node: ItemNode) => withTrackUri(node, (uri) => actions.toggleLike(uri)),
    'spotifySidebar.addItemToPlaylist': (node: ItemNode) => withTrackUri(node, (uri) => actions.addToPlaylist(uri)),
    'spotifySidebar.transferToDevice': (node: DeviceTreeNode) => (node?.kind === 'device' ? actions.transferToDevice(node.device) : undefined),
  };
  return Object.entries(handlers).map(([id, handler]) => vscode.commands.registerCommand(id, handler));
}

async function promptSearch(nowPlaying: NowPlayingViewProvider): Promise<void> {
  const query = await vscode.window.showInputBox({ title: 'Search Spotify', placeHolder: 'Song, album, artist or playlist' });
  if (query?.trim()) await nowPlaying.startSearch(query.trim());
}

function withTrackUri(node: ItemNode | undefined, run: (uri: string) => Promise<void>): Promise<void> | undefined {
  return node?.kind === 'track' ? run(node.item.uri) : undefined;
}
