import * as vscode from 'vscode';
import type { SpotifyActions } from '../actions.ts';
import { describeError } from '../actions.ts';
import { collectPages, type SpotifyApi } from '../api/endpoints.ts';
import { SpotifyApiError } from '../api/spotifyClient.ts';
import type { PlayableItem, SimplifiedPlaylist, Track } from '../api/types.ts';
import { formatDuration } from '../shared/format.ts';
import { getOrLoad } from '../shared/promiseCache.ts';
import type { PlayerState } from '../state/playerState.ts';
import { joinArtistNames, uniqueRecentTracks } from '../state/viewModels.ts';

// Bounds memory and request count for very large playlists.
const MAX_TRACKS_PER_LIST = 500;
// Spotify rejects overly long `uris` arrays in a play request.
const MAX_PLAY_URIS = 100;
const LIKED_SONGS_ID = 'liked-songs';
const RECENTLY_PLAYED_ID = 'recently-played';

/** Where a track node came from, which decides how clicking it starts playback. */
export type TrackSource =
  | { kind: 'playlist'; contextUri: string; position: number }
  | { kind: 'uris'; siblingUris: string[]; index: number };

export type PlaylistTreeNode =
  | { kind: 'recent' }
  | { kind: 'liked' }
  | { kind: 'playlist'; playlist: SimplifiedPlaylist }
  | { kind: 'track'; item: PlayableItem; source: TrackSource; parentId: string }
  | { kind: 'message'; text: string; tooltip?: string };

export class PlaylistTreeProvider implements vscode.TreeDataProvider<PlaylistTreeNode>, vscode.Disposable {
  private readonly api: SpotifyApi;
  private readonly player: PlayerState;
  private readonly actions: SpotifyActions;
  private readonly changeEmitter = new vscode.EventEmitter<PlaylistTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Holds in-flight loads too, so expanding a node while "Play" reads it fetches the list once. */
  private readonly childrenCache = new Map<string, Promise<PlaylistTreeNode[]>>();
  private readonly recentlyPlayedNode: PlaylistTreeNode = { kind: 'recent' };
  private readonly likedSongsNode: PlaylistTreeNode = { kind: 'liked' };
  private lastSeenTrackUri: string | undefined;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(api: SpotifyApi, player: PlayerState, actions: SpotifyActions) {
    this.api = api;
    this.player = player;
    this.actions = actions;
    this.disposables.push(
      player.onDidChange(() => this.handlePlaybackChange()),
      actions.onDidChangePlaylists(() => this.refresh()),
      actions.onDidChangeLibrary(() => this.refreshLikedSongs()),
    );
  }

  refresh(): void {
    this.actions.invalidatePlaylists();
    this.childrenCache.clear();
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: PlaylistTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'recent': {
        const item = new vscode.TreeItem('Recently Played', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = RECENTLY_PLAYED_ID;
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'recent';
        return item;
      }
      case 'liked': {
        const item = new vscode.TreeItem('Liked Songs', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = LIKED_SONGS_ID;
        item.iconPath = new vscode.ThemeIcon('heart-filled');
        item.contextValue = 'liked';
        return item;
      }
      case 'playlist': {
        const { playlist } = node;
        const item = new vscode.TreeItem(playlist.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = playlist.id;
        item.iconPath = new vscode.ThemeIcon('list-unordered');
        item.description = playlist.items ? `${playlist.items.total}` : undefined;
        item.tooltip = `${playlist.name}\nBy ${playlist.owner.display_name ?? playlist.owner.id}`;
        item.contextValue = 'playlist';
        return item;
      }
      case 'track':
        return buildTrackItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        item.tooltip = node.tooltip;
        return item;
      }
    }
  }

  async getChildren(node?: PlaylistTreeNode): Promise<PlaylistTreeNode[]> {
    try {
      if (!node) return await this.loadRoot();
      if (node.kind === 'recent') return await getOrLoad(this.childrenCache, RECENTLY_PLAYED_ID, () => this.loadRecentlyPlayed());
      if (node.kind === 'liked') return await getOrLoad(this.childrenCache, LIKED_SONGS_ID, () => this.loadLikedSongs());
      if (node.kind === 'playlist') {
        return await getOrLoad(this.childrenCache, node.playlist.id, () => this.loadPlaylistTracks(node.playlist));
      }
      return [];
    } catch (error) {
      return [toMessageNode(error)];
    }
  }

  /** Arguments passed to `spotifySidebar.playItem` from this tree. */
  playNode(node: PlaylistTreeNode): Promise<void> {
    switch (node.kind) {
      case 'recent':
      case 'liked':
        return this.playFirstChild(node);
      case 'playlist':
        return this.actions.play({ contextUri: node.playlist.uri });
      case 'track':
        return this.playTrackNode(node.source);
      case 'message':
        return Promise.resolve();
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private refreshLikedSongs(): void {
    if (this.childrenCache.delete(LIKED_SONGS_ID)) this.changeEmitter.fire(this.likedSongsNode);
  }

  /** A new track means the previous one just joined the history, so reload the list if it was opened. */
  private handlePlaybackChange(): void {
    const trackUri = this.player.current?.item?.uri;
    if (trackUri === this.lastSeenTrackUri) return;
    this.lastSeenTrackUri = trackUri;
    if (this.childrenCache.delete(RECENTLY_PLAYED_ID)) this.changeEmitter.fire(this.recentlyPlayedNode);
  }

  private async loadRoot(): Promise<PlaylistTreeNode[]> {
    const playlists = await this.actions.fetchMyPlaylists();
    return [this.recentlyPlayedNode, this.likedSongsNode, ...playlists.map((playlist): PlaylistTreeNode => ({ kind: 'playlist', playlist }))];
  }

  private async loadRecentlyPlayed(): Promise<PlaylistTreeNode[]> {
    try {
      const tracks = uniqueRecentTracks(await this.api.getRecentlyPlayed());
      if (tracks.length === 0) return [{ kind: 'message', text: 'Nothing played yet' }];
      return toUriListNodes(tracks, RECENTLY_PLAYED_ID);
    } catch (error) {
      // Sessions from before this view existed lack the user-read-recently-played scope.
      if (error instanceof SpotifyApiError && error.status === 403) {
        return [{
          kind: 'message',
          text: 'Log out and in again to see recently played',
          tooltip: 'This needs a permission your current login did not grant.',
        }];
      }
      throw error;
    }
  }

  private async loadLikedSongs(): Promise<PlaylistTreeNode[]> {
    const { items, total } = await collectPages((page) => this.api.getSavedTracks(page), MAX_TRACKS_PER_LIST);
    const nodes = toUriListNodes(items.map((saved) => saved.track), LIKED_SONGS_ID);
    return withTruncationNotice(nodes, total);
  }

  private async loadPlaylistTracks(playlist: SimplifiedPlaylist): Promise<PlaylistTreeNode[]> {
    try {
      const { items, total } = await collectPages((page) => this.api.getPlaylistItems(playlist.id, page), MAX_TRACKS_PER_LIST);
      const nodes: PlaylistTreeNode[] = [];
      items.forEach((entry, position) => {
        if (entry.item) {
          nodes.push({ kind: 'track', item: entry.item, source: { kind: 'playlist', contextUri: playlist.uri, position }, parentId: playlist.id });
        }
      });
      return withTruncationNotice(nodes, total);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403) {
        return [{
          kind: 'message',
          text: 'Track list unavailable for followed playlists',
          tooltip: 'Spotify only lists tracks of playlists you own or collaborate on. Use the play button to play it.',
        }];
      }
      throw error;
    }
  }

  private async playFirstChild(node: PlaylistTreeNode): Promise<void> {
    const nodes = await this.getChildren(node);
    const first = nodes.find((node) => node.kind === 'track');
    if (first?.kind === 'track') await this.playTrackNode(first.source);
  }

  private playTrackNode(source: TrackSource): Promise<void> {
    if (source.kind === 'playlist') {
      return this.actions.play({ contextUri: source.contextUri, offsetPosition: source.position });
    }
    // Liked Songs and the listening history have no public context URI, so play a window of the list starting at the clicked track.
    return this.actions.play({ uris: source.siblingUris.slice(source.index, source.index + MAX_PLAY_URIS) });
  }
}

function buildTrackItem(node: Extract<PlaylistTreeNode, { kind: 'track' }>): vscode.TreeItem {
  const { item: playable } = node;
  const item = new vscode.TreeItem(playable.name, vscode.TreeItemCollapsibleState.None);
  // Position keeps ids unique when a playlist contains the same track twice.
  const position = node.source.kind === 'playlist' ? node.source.position : node.source.index;
  item.id = `${node.parentId}/${position}/${playable.uri}`;

  if (playable.type === 'track') {
    const artists = joinArtistNames(playable);
    item.description = artists;
    item.tooltip = `${playable.name}\n${artists}\n${playable.album.name} · ${formatDuration(playable.duration_ms)}`;
    item.iconPath = new vscode.ThemeIcon('music');
  } else {
    item.description = playable.show?.name;
    item.tooltip = `${playable.name} · ${formatDuration(playable.duration_ms)}`;
    item.iconPath = new vscode.ThemeIcon('mic');
  }
  item.contextValue = 'track';
  item.command = { command: 'spotifySidebar.playItem', title: 'Play', arguments: [node] };
  return item;
}

/** Tracks with no playable context, which play as a list starting at the clicked one. */
function toUriListNodes(tracks: Track[], parentId: string): PlaylistTreeNode[] {
  const siblingUris = tracks.map((track) => track.uri);
  return tracks.map((track, index) => ({ kind: 'track', item: track, source: { kind: 'uris', siblingUris, index }, parentId }));
}

function withTruncationNotice(nodes: PlaylistTreeNode[], total: number): PlaylistTreeNode[] {
  if (nodes.length === 0) return [{ kind: 'message', text: 'No tracks' }];
  if (total <= MAX_TRACKS_PER_LIST) return nodes;
  return [...nodes, { kind: 'message', text: `Showing the first ${MAX_TRACKS_PER_LIST} of ${total} tracks` }];
}

function toMessageNode(error: unknown): PlaylistTreeNode {
  return { kind: 'message', text: 'Could not load from Spotify', tooltip: describeError(error) };
}
