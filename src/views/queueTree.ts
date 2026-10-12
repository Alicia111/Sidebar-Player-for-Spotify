import * as vscode from 'vscode';
import { describeError, type SpotifyActions } from '../actions.ts';
import type { SpotifyApi } from '../api/endpoints.ts';
import type { PlayableItem } from '../api/types.ts';
import { formatDuration } from '../shared/format.ts';
import type { PlayerState } from '../state/playerState.ts';
import { fetchSettledQueue } from '../state/queueSync.ts';
import { joinArtistNames } from '../state/viewModels.ts';

export const QUEUE_VIEW_ID = 'spotifySidebar.queue';
// Spotify's queue endpoint can trail a track change by a second or two.
const QUEUE_SETTLE_RETRIES = 3;
const QUEUE_SETTLE_DELAY_MS = 700;

const CONTEXT_ICONS: Record<string, string> = {
  playlist: 'list-unordered',
  album: 'library',
  artist: 'person',
  show: 'mic',
  collection: 'heart-filled',
};

export type QueueTreeNode =
  | { kind: 'context'; label: string; contextType: string }
  | { kind: 'track'; item: PlayableItem; role: 'current' | 'upcoming'; position: number; contextUri: string | undefined }
  | { kind: 'message'; text: string; tooltip?: string };

/** "Playing from …", the current item and what Spotify will play next. */
export class QueueTreeProvider implements vscode.TreeDataProvider<QueueTreeNode>, vscode.Disposable {
  private readonly api: SpotifyApi;
  private readonly player: PlayerState;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly contextNames = new Map<string, string>();
  private treeView: vscode.TreeView<QueueTreeNode> | undefined;
  /** Track + context the tree was last built for; a change means the queue moved on. */
  private renderedKey: string | undefined;
  private isStale = true;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(api: SpotifyApi, player: PlayerState, actions: SpotifyActions) {
    this.api = api;
    this.player = player;
    this.disposables.push(
      player.onDidChange(() => this.onPlayerChange()),
      actions.onDidChangeQueue(() => this.refresh()),
    );
  }

  attach(treeView: vscode.TreeView<QueueTreeNode>): void {
    this.treeView = treeView;
    this.disposables.push(
      treeView.onDidChangeVisibility(({ visible }) => {
        if (visible && this.isStale) this.refresh();
      }),
    );
  }

  refresh(): void {
    this.isStale = false;
    this.changeEmitter.fire();
  }

  getTreeItem(node: QueueTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'context': {
        const item = new vscode.TreeItem(node.label);
        item.description = node.contextType === 'collection' ? undefined : node.contextType;
        item.iconPath = new vscode.ThemeIcon(CONTEXT_ICONS[node.contextType] ?? 'play-circle');
        item.tooltip = `Playing from ${node.label}`;
        return item;
      }
      case 'track':
        return buildQueueItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        item.tooltip = node.tooltip;
        return item;
      }
    }
  }

  async getChildren(node?: QueueTreeNode): Promise<QueueTreeNode[]> {
    if (node) return [];
    try {
      return await this.loadQueue();
    } catch (error) {
      return [{ kind: 'message', text: 'Could not load the queue', tooltip: describeError(error) }];
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private onPlayerChange(): void {
    if (this.playbackKey() === this.renderedKey) return;
    // Hidden views don't need fresh data; fetch once they are shown again.
    if (this.treeView?.visible) this.refresh();
    else this.isStale = true;
  }

  /** Same key on both sides of the comparison: what the playback endpoint says is playing, and from where. */
  private playbackKey(): string {
    const playback = this.player.current;
    return `${playback?.item?.uri ?? ''}|${playback?.context?.uri ?? ''}`;
  }

  private async loadQueue(): Promise<QueueTreeNode[]> {
    const context = this.player.current?.context ?? null;
    const [{ queue, isSettled }, contextNode] = await Promise.all([
      fetchSettledQueue({
        fetchQueue: () => this.api.getQueue(),
        getPlayingUri: () => this.player.current?.item?.uri,
        retries: QUEUE_SETTLE_RETRIES,
        delayMs: QUEUE_SETTLE_DELAY_MS,
      }),
      this.loadContextNode(context?.uri),
    ]);
    // A lagging answer is shown but not remembered, so the next poll fetches the queue again.
    this.renderedKey = isSettled ? this.playbackKey() : undefined;

    const current = queue.currently_playing ?? this.player.current?.item ?? null;
    if (!current && queue.queue.length === 0) {
      return [{ kind: 'message', text: 'Nothing is playing right now.' }];
    }
    const nodes: QueueTreeNode[] = contextNode ? [contextNode] : [];
    if (current) {
      nodes.push({ kind: 'track', item: current, role: 'current', position: 0, contextUri: context?.uri });
    }
    queue.queue.forEach((item, index) => {
      nodes.push({ kind: 'track', item, role: 'upcoming', position: index + 1, contextUri: context?.uri });
    });
    if (queue.queue.length === 0) nodes.push({ kind: 'message', text: 'Nothing queued after this.' });
    return nodes;
  }

  private async loadContextNode(contextUri: string | undefined): Promise<QueueTreeNode | undefined> {
    if (!contextUri) return undefined;
    const contextType = contextUri.endsWith(':collection') ? 'collection' : contextUri.split(':')[1] ?? 'context';
    return { kind: 'context', label: await this.resolveContextName(contextUri), contextType };
  }

  /** A missing name is cosmetic, so failures fall back to a generic label instead of failing the tree. */
  private async resolveContextName(contextUri: string): Promise<string> {
    const cached = this.contextNames.get(contextUri);
    if (cached) return cached;
    try {
      const name = (await this.api.getContextName(contextUri)) ?? 'Unknown source';
      this.contextNames.set(contextUri, name);
      return name;
    } catch {
      return 'Current playlist';
    }
  }
}

function buildQueueItem(node: Extract<QueueTreeNode, { kind: 'track' }>): vscode.TreeItem {
  const { item: playable } = node;
  const item = new vscode.TreeItem(playable.name);
  // Queues can contain the same track twice, so the position keeps ids unique.
  item.id = `queue/${node.position}/${playable.uri}`;
  const byline = playable.type === 'track' ? joinArtistNames(playable) : playable.show?.name ?? 'Podcast';
  item.description = byline;
  item.tooltip = `${playable.name}\n${byline} · ${formatDuration(playable.duration_ms)}`;

  if (node.role === 'current') {
    item.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'));
    item.tooltip = `Now playing\n${item.tooltip}`;
    item.contextValue = 'queueCurrent';
    return item;
  }
  item.iconPath = new vscode.ThemeIcon(playable.type === 'track' ? 'music' : 'mic');
  item.contextValue = 'queueTrack';
  item.command = { command: 'spotifySidebar.playQueueItem', title: 'Play', arguments: [node] };
  return item;
}
