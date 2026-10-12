import * as vscode from 'vscode';
import type { SpotifyApi } from '../api/endpoints.ts';
import type { PlaybackState } from '../api/types.ts';
import type { AuthManager } from '../auth/authManager.ts';
import { NotLoggedInError } from '../auth/authManager.ts';
import type { NowPlayingView } from '../shared/protocol.ts';
import { isLikeable, toNowPlayingView } from './viewModels.ts';

// When only the status bar is showing, poll this many times slower than the visible-view rate.
const BACKGROUND_POLL_FACTOR = 5;
// Give Spotify a moment to apply a command before reading the new state back.
const REFRESH_AFTER_COMMAND_MS = 400;
const MAX_LIKED_CACHE_ENTRIES = 500;

/** Single source of truth for what is playing; polls only while someone can see the result. */
export class PlayerState implements vscode.Disposable {
  private readonly api: SpotifyApi;
  private readonly auth: AuthManager;
  private readonly log: vscode.LogOutputChannel;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly likedState = new Map<string, boolean>();

  private playback: PlaybackState | null = null;
  private sampledAt = 0;
  private refreshInFlight: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private isWindowFocused = vscode.window.state.focused;
  /** Surfaces (sidebar view, lyrics panel…) currently on screen; any of them wants fast polling. */
  private readonly visibleSurfaces = new Set<string>();
  private lastPollError: string | undefined;
  private isDisposed = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(api: SpotifyApi, auth: AuthManager, log: vscode.LogOutputChannel) {
    this.api = api;
    this.auth = auth;
    this.log = log;
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        this.isWindowFocused = state.focused;
        if (state.focused) void this.refresh();
        this.schedulePoll();
      }),
      auth.onDidChangeLoginState((isLoggedIn) => {
        if (!isLoggedIn) this.reset();
        else void this.refresh();
        this.schedulePoll();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('spotifySidebar.pollIntervalMs')) this.schedulePoll();
      }),
    );
  }

  get view(): NowPlayingView | null {
    return toNowPlayingView(this.playback, this.sampledAt, this.likedState);
  }

  get current(): PlaybackState | null {
    return this.playback;
  }

  setSurfaceVisible(surfaceId: string, isVisible: boolean): void {
    if (isVisible) this.visibleSurfaces.add(surfaceId);
    else this.visibleSurfaces.delete(surfaceId);
    if (isVisible) void this.refresh();
    this.schedulePoll();
  }

  /** Re-reads playback state; concurrent callers share the same request. */
  refresh(): Promise<void> {
    this.refreshInFlight ??= this.fetchPlayback().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  refreshSoon(): void {
    setTimeout(() => void this.refresh(), REFRESH_AFTER_COMMAND_MS);
  }

  /** Applies an expected change immediately so the UI feels instant; the next poll corrects it. */
  applyOptimistic(update: (playback: PlaybackState) => void): void {
    if (!this.playback) return;
    this.playback.progress_ms = this.estimatedProgressMs();
    this.sampledAt = Date.now();
    update(this.playback);
    this.changeEmitter.fire();
  }

  getLiked(uri: string): boolean | undefined {
    return this.likedState.get(uri);
  }

  setLiked(uri: string, isLiked: boolean): void {
    if (this.likedState.size >= MAX_LIKED_CACHE_ENTRIES) this.likedState.clear();
    this.likedState.set(uri, isLiked);
    if (this.playback?.item?.uri === uri) this.changeEmitter.fire();
  }

  dispose(): void {
    this.isDisposed = true;
    clearTimeout(this.pollTimer);
    this.changeEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async fetchPlayback(): Promise<void> {
    if (!this.auth.isLoggedIn) return;
    try {
      const playback = await this.api.getPlaybackState();
      this.playback = playback;
      this.sampledAt = Date.now();
      this.lastPollError = undefined;
      await this.loadLikedStateFor(playback);
      this.changeEmitter.fire();
    } catch (error) {
      this.reportPollError(error);
    }
  }

  private async loadLikedStateFor(playback: PlaybackState | null): Promise<void> {
    const item = playback?.item;
    if (!item || !isLikeable(item) || this.likedState.has(item.uri)) return;
    const contains = await this.api.libraryContains([item.uri]);
    this.setLiked(item.uri, contains.get(item.uri) === true);
  }

  private reportPollError(error: unknown): void {
    if (error instanceof NotLoggedInError) return;
    const message = error instanceof Error ? error.message : String(error);
    // Polling repeats every few seconds; log each distinct failure once instead of flooding the channel.
    if (message !== this.lastPollError) {
      this.log.warn(`Refreshing playback state failed: ${message}`);
      this.lastPollError = message;
    }
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    const intervalMs = this.currentPollIntervalMs();
    if (intervalMs === undefined) return;

    this.pollTimer = setTimeout(async () => {
      await this.refresh();
      this.schedulePoll();
    }, intervalMs);
  }

  private currentPollIntervalMs(): number | undefined {
    if (this.isDisposed || !this.auth.isLoggedIn || !this.isWindowFocused) return undefined;
    const baseMs = Math.max(1000, vscode.workspace.getConfiguration('spotifySidebar').get<number>('pollIntervalMs', 3000));
    return this.visibleSurfaces.size > 0 ? baseMs : baseMs * BACKGROUND_POLL_FACTOR;
  }

  private estimatedProgressMs(): number {
    const playback = this.playback;
    if (!playback) return 0;
    const progress = playback.progress_ms ?? 0;
    if (!playback.is_playing) return progress;
    const duration = playback.item?.duration_ms ?? Number.MAX_SAFE_INTEGER;
    return Math.min(duration, progress + (Date.now() - this.sampledAt));
  }

  private reset(): void {
    this.playback = null;
    this.likedState.clear();
    this.changeEmitter.fire();
  }
}
