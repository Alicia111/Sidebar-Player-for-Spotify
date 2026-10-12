import * as vscode from 'vscode';
import { collectPages, type PlayRequest, type SpotifyApi } from './api/endpoints.ts';
import { SpotifyApiError } from './api/spotifyClient.ts';
import type { Device, PlayableItem, RepeatMode, SimplifiedPlaylist } from './api/types.ts';
import { NotLoggedInError, type AuthManager } from './auth/authManager.ts';
import { LoginCancelledError } from './auth/loopbackServer.ts';
import { launchSpotifyDesktop } from './device/desktopLauncher.ts';
import { chooseDevice, isControllable, waitForDevice } from './device/deviceChoice.ts';
import { minimizeSpotifyWindow } from './device/windowMinimizer.ts';
import { getOrLoad } from './shared/promiseCache.ts';
import type { PlayerState } from './state/playerState.ts';

const NEXT_REPEAT_MODE: Record<RepeatMode, RepeatMode> = { off: 'context', context: 'track', track: 'off' };
// Spotify needs a moment after a transfer before the new device accepts commands.
const DEVICE_WAKE_DELAY_MS = 600;
const MAX_PLAYLISTS = 1000;
const MY_PLAYLISTS_CACHE_KEY = 'mine';
const LAST_DEVICE_KEY = 'spotifySidebar.lastDeviceId';
// The desktop app needs a few seconds after launch before it registers as a Connect device.
const DESKTOP_STARTUP_TIMEOUT_MS = 30_000;
const DEVICE_POLL_INTERVAL_MS = 1_500;

const DEVICE_ICONS: Record<string, string> = {
  computer: 'device-desktop',
  smartphone: 'device-mobile',
  tablet: 'device-mobile',
  speaker: 'unmute',
  tv: 'vm',
  castvideo: 'vm',
  castaudio: 'radio-tower',
};

export function deviceIconId(device: Device): string {
  return DEVICE_ICONS[device.type.toLowerCase()] ?? 'unmute';
}

/** Every user-triggered Spotify operation, with consistent error reporting. */
export class SpotifyActions implements vscode.Disposable {
  private readonly api: SpotifyApi;
  private readonly auth: AuthManager;
  private readonly player: PlayerState;
  private readonly log: vscode.LogOutputChannel;
  private readonly memento: vscode.Memento;
  private readonly extensionUri: vscode.Uri;
  private readonly playlistsChangedEmitter = new vscode.EventEmitter<void>();
  private readonly libraryChangedEmitter = new vscode.EventEmitter<void>();
  private readonly devicesChangedEmitter = new vscode.EventEmitter<void>();
  private readonly queueChangedEmitter = new vscode.EventEmitter<void>();
  private currentUserId: string | undefined;
  /** Listing every playlist can take 20 requests; the tree and the "Add to playlist" picker share one copy. */
  private readonly playlistCache = new Map<string, Promise<SimplifiedPlaylist[]>>();

  readonly onDidChangePlaylists = this.playlistsChangedEmitter.event;
  readonly onDidChangeLibrary = this.libraryChangedEmitter.event;
  readonly onDidChangeDevices = this.devicesChangedEmitter.event;
  readonly onDidChangeQueue = this.queueChangedEmitter.event;

  constructor(deps: {
    api: SpotifyApi;
    auth: AuthManager;
    player: PlayerState;
    log: vscode.LogOutputChannel;
    memento: vscode.Memento;
    extensionUri: vscode.Uri;
  }) {
    this.api = deps.api;
    this.auth = deps.auth;
    this.player = deps.player;
    this.log = deps.log;
    this.memento = deps.memento;
    this.extensionUri = deps.extensionUri;
  }

  // ---- Session ------------------------------------------------------------

  login(): Promise<void> {
    return this.run('Log in', async () => {
      const isLoggedIn = await this.auth.login();
      if (isLoggedIn) vscode.window.showInformationMessage('Logged in to Spotify.');
    });
  }

  logout(): Promise<void> {
    return this.run('Log out', async () => {
      this.currentUserId = undefined;
      this.playlistCache.clear();
      await this.auth.logout();
    });
  }

  // ---- Transport ----------------------------------------------------------

  playPause(): Promise<void> {
    return this.runPlayback('Play/pause', async () => {
      const isPlaying = this.player.current?.is_playing === true;
      this.player.applyOptimistic((playback) => (playback.is_playing = !isPlaying));
      if (isPlaying) await this.api.pause();
      else await this.api.play();
    });
  }

  next(): Promise<void> {
    return this.runPlayback('Next track', () => this.api.next());
  }

  previous(): Promise<void> {
    return this.runPlayback('Previous track', () => this.api.previous());
  }

  seek(positionMs: number): Promise<void> {
    return this.runPlayback('Seek', async () => {
      this.player.applyOptimistic((playback) => (playback.progress_ms = positionMs));
      await this.api.seek(positionMs);
    });
  }

  setVolume(percent: number): Promise<void> {
    return this.runPlayback('Set volume', async () => {
      this.player.applyOptimistic((playback) => (playback.device.volume_percent = percent));
      await this.api.setVolume(percent);
    });
  }

  toggleShuffle(): Promise<void> {
    return this.runPlayback('Toggle shuffle', async () => {
      const isEnabled = !(this.player.current?.shuffle_state ?? false);
      this.player.applyOptimistic((playback) => (playback.shuffle_state = isEnabled));
      await this.api.setShuffle(isEnabled);
    });
  }

  cycleRepeat(): Promise<void> {
    return this.runPlayback('Change repeat mode', async () => {
      const mode = NEXT_REPEAT_MODE[this.player.current?.repeat_state ?? 'off'];
      this.player.applyOptimistic((playback) => (playback.repeat_state = mode));
      await this.api.setRepeat(mode);
    });
  }

  play(request: PlayRequest): Promise<void> {
    return this.runPlayback('Play', () => this.api.play(request));
  }

  /**
   * Albums, artists and playlists play as a context. A track plays inside `contextUri` when given, so playback
   * carries on after it; a lone one-track list would stop there, or loop it forever with repeat on.
   */
  playUri(uri: string, contextUri?: string): Promise<void> {
    const isTrack = uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:');
    if (!isTrack) return this.play({ contextUri: uri });
    return this.play(contextUri ? { contextUri, offsetUri: uri } : { uris: [uri] });
  }

  addToQueue(uri: string): Promise<void> {
    return this.run('Add to queue', async () => {
      await this.withDeviceRecovery(() => this.api.addToQueue(uri));
      vscode.window.setStatusBarMessage('$(check) Added to queue', 2500);
      this.queueChangedEmitter.fire();
    });
  }

  /**
   * Jumps to an upcoming queue item. Context items are started inside the context so the rest of the
   * playlist keeps playing. Manually queued items aren't part of it, so tracks fall back to their album.
   */
  playFromQueue(item: PlayableItem, contextUri: string | undefined): Promise<void> {
    const uri = item.uri;
    return this.runPlayback('Play from queue', async () => {
      if (contextUri) {
        try {
          await this.api.play({ contextUri, offsetUri: uri });
          return;
        } catch (error) {
          if (!(error instanceof SpotifyApiError) || error.isNoActiveDevice || error.status >= 500) throw error;
          this.log.info(`${uri} is not in ${contextUri} (HTTP ${error.status}); playing it from its album.`);
        }
      }
      await this.api.play(item.type === 'track' && !item.is_local ? { contextUri: item.album.uri, offsetUri: uri } : { uris: [uri] });
    });
  }

  // ---- Likes --------------------------------------------------------------

  toggleLikeCurrent(): Promise<void> {
    return this.run('Like', async () => {
      const item = this.player.current?.item;
      if (!item || item.type !== 'track' || item.is_local) {
        vscode.window.showInformationMessage('Nothing likeable is playing right now.');
        return;
      }
      const isLiked = this.player.getLiked(item.uri) ?? (await this.api.libraryContains([item.uri])).get(item.uri) === true;
      await this.applyLike(item.uri, !isLiked);
    });
  }

  /** Flips the saved state of any track, looking it up first when unknown. */
  toggleLike(uri: string): Promise<void> {
    return this.run('Like', async () => {
      const isLiked = this.player.getLiked(uri) ?? (await this.api.libraryContains([uri])).get(uri) === true;
      await this.applyLike(uri, !isLiked);
      vscode.window.setStatusBarMessage(isLiked ? '$(heart) Removed from Liked Songs' : '$(heart-filled) Added to Liked Songs', 2500);
    });
  }

  setLiked(uri: string, isLiked: boolean): Promise<void> {
    return this.run('Like', () => this.applyLike(uri, isLiked));
  }

  // ---- Playlists ----------------------------------------------------------

  addToPlaylist(uri: string): Promise<void> {
    return this.run('Add to playlist', async () => {
      const playlist = await this.pickEditablePlaylist();
      if (!playlist) return;
      await this.api.addItemsToPlaylist(playlist.id, [uri]);
      vscode.window.setStatusBarMessage(`$(check) Added to ${playlist.name}`, 2500);
      this.notifyPlaylistsChanged();
    });
  }

  addCurrentToPlaylist(): Promise<void> {
    const uri = this.player.current?.item?.uri;
    if (!uri) {
      vscode.window.showInformationMessage('Nothing is playing right now.');
      return Promise.resolve();
    }
    return this.addToPlaylist(uri);
  }

  createPlaylist(): Promise<void> {
    return this.run('Create playlist', async () => {
      const name = await vscode.window.showInputBox({
        title: 'New Spotify Playlist',
        prompt: 'The playlist is created as private.',
        validateInput: (value) => (value.trim() ? undefined : 'Name cannot be empty'),
      });
      if (!name) return;
      await this.api.createPlaylist(name.trim(), 'Created from VS Code');
      this.notifyPlaylistsChanged();
    });
  }

  fetchMyPlaylists(): Promise<SimplifiedPlaylist[]> {
    return getOrLoad(this.playlistCache, MY_PLAYLISTS_CACHE_KEY, async () => {
      const { items } = await collectPages((page) => this.api.getMyPlaylists(page), MAX_PLAYLISTS);
      return items;
    });
  }

  /** Drops the cached playlist list, e.g. on a manual refresh, so the next read asks Spotify again. */
  invalidatePlaylists(): void {
    this.playlistCache.clear();
  }

  async getCurrentUserId(): Promise<string> {
    this.currentUserId ??= (await this.api.getCurrentUser()).id;
    return this.currentUserId;
  }

  // ---- Devices ------------------------------------------------------------

  selectDevice(): Promise<void> {
    return this.run('Select device', async () => {
      await this.pickAndTransferDevice();
    });
  }

  transferToDevice(device: Device): Promise<void> {
    return this.run('Switch device', () => this.transferTo(device));
  }

  // ---- Internals ----------------------------------------------------------

  dispose(): void {
    this.playlistsChangedEmitter.dispose();
    this.libraryChangedEmitter.dispose();
    this.devicesChangedEmitter.dispose();
    this.queueChangedEmitter.dispose();
  }

  private notifyPlaylistsChanged(): void {
    this.invalidatePlaylists();
    this.playlistsChangedEmitter.fire();
  }

  private async applyLike(uri: string, isLiked: boolean): Promise<void> {
    if (isLiked) await this.api.saveToLibrary([uri]);
    else await this.api.removeFromLibrary([uri]);
    this.player.setLiked(uri, isLiked);
    this.libraryChangedEmitter.fire();
  }

  private runPlayback(label: string, operation: () => Promise<void>): Promise<void> {
    return this.run(label, async () => {
      await this.withDeviceRecovery(operation);
      this.player.refreshSoon();
    });
  }

  /** When Spotify has no active device, let the user pick one and retry once. */
  private async withDeviceRecovery(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof SpotifyApiError && error.isNoActiveDevice)) throw error;
      this.log.info(`No active device for ${error.method} ${error.path}; choosing one automatically.`);
      const device = await this.ensureDevice();
      if (!device) {
        this.player.refreshSoon();
        return;
      }
      await operation();
    }
  }

  /** Finds a device to play on without asking when the answer is obvious, launching the desktop app if needed. */
  private async ensureDevice(): Promise<Device | undefined> {
    const choice = chooseDevice(await this.api.getDevices(), this.memento.get<string>(LAST_DEVICE_KEY));
    switch (choice.kind) {
      case 'use':
        this.log.info(`Using device "${choice.device.name}".`);
        await this.transferTo(choice.device);
        return choice.device;
      case 'ask':
        return this.askAndTransfer(choice.devices);
      case 'none':
        return this.startDesktopDevice();
    }
  }

  private async startDesktopDevice(): Promise<Device | undefined> {
    const config = vscode.workspace.getConfiguration('spotifySidebar');
    if (!config.get<boolean>('autoLaunchDesktop', true)) {
      await this.showNoDeviceHelp();
      return undefined;
    }

    const command = config.get<string>('desktopCommand', 'spotify');
    const shouldMinimize = config.get<boolean>('minimizeDesktop', true);
    this.log.info(`No Spotify devices online; launching "${command}"${shouldMinimize ? ' minimized' : ''}.`);
    // Spotify honours --minimized only on Windows; Linux gets the window iconified after it appears.
    await launchSpotifyDesktop(command, shouldMinimize && process.platform === 'win32' ? ['--minimized'] : []);
    if (shouldMinimize && process.platform === 'linux') void this.minimizeLaunchedWindow();
    const device = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting Spotify…', cancellable: true },
      (_progress, cancellation) =>
        waitForDevice({
          fetchDevices: () => this.api.getDevices(),
          timeoutMs: DESKTOP_STARTUP_TIMEOUT_MS,
          intervalMs: DEVICE_POLL_INTERVAL_MS,
          isCancelled: () => cancellation.isCancellationRequested,
        }),
    );
    if (!device) {
      vscode.window.showWarningMessage('Spotify started but did not show up as a device yet. Make sure you are logged in to the app, then try again.');
      return undefined;
    }
    await this.transferTo(device);
    return device;
  }

  private async minimizeLaunchedWindow(): Promise<void> {
    const scriptPath = vscode.Uri.joinPath(this.extensionUri, 'scripts', 'minimize_spotify_window.py').fsPath;
    const { outcome, detail } = await minimizeSpotifyWindow(scriptPath);
    const message = `Minimizing the Spotify window: ${outcome}${detail ? ` (${detail})` : ''}`;
    if (outcome === 'minimized') this.log.info(message);
    else this.log.warn(message);
  }

  private async showNoDeviceHelp(): Promise<void> {
    const openWebPlayer = 'Open Web Player';
    const choice = await vscode.window.showWarningMessage(
      'No Spotify devices found. Open Spotify on your computer or phone (or the web player), then try again.',
      openWebPlayer,
    );
    if (choice === openWebPlayer) await vscode.env.openExternal(vscode.Uri.parse('https://open.spotify.com'));
  }

  /** Explicit device switch: always lets the user choose, launching the desktop app when nothing is online. */
  private async pickAndTransferDevice(): Promise<Device | undefined> {
    const devices = (await this.api.getDevices()).filter(isControllable);
    if (devices.length === 0) return this.startDesktopDevice();
    return this.askAndTransfer(devices);
  }

  private async askAndTransfer(devices: Device[]): Promise<Device | undefined> {
    const picked = await vscode.window.showQuickPick(
      devices.map((device) => ({
        label: `$(${deviceIconId(device)}) ${device.name}`,
        description: device.is_active ? 'active' : device.type,
        device,
      })),
      { title: 'Play on which device?', placeHolder: 'Spotify devices on your account' },
    );
    if (!picked) return undefined;
    await this.transferTo(picked.device);
    return picked.device;
  }

  private async transferTo(device: Device): Promise<void> {
    if (!device.id) throw new Error(`Device "${device.name}" has no id and cannot be controlled`);
    await this.api.transferPlayback(device.id, this.player.current?.is_playing ?? false);
    await this.memento.update(LAST_DEVICE_KEY, device.id);
    await new Promise((resolve) => setTimeout(resolve, DEVICE_WAKE_DELAY_MS));
    this.devicesChangedEmitter.fire();
    this.player.refreshSoon();
  }

  private async pickEditablePlaylist(): Promise<SimplifiedPlaylist | undefined> {
    const [playlists, userId] = await Promise.all([this.fetchMyPlaylists(), this.getCurrentUserId()]);
    const editable = playlists.filter((playlist) => playlist.owner.id === userId || playlist.collaborative);
    if (editable.length === 0) {
      vscode.window.showInformationMessage('You have no playlists you can edit. Create one first.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      editable.map((playlist) => ({
        label: playlist.name,
        description: playlist.items ? `${playlist.items.total} tracks` : undefined,
        playlist,
      })),
      { title: 'Add to playlist', placeHolder: 'Choose a playlist' },
    );
    return picked?.playlist;
  }

  private async run(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      await this.reportError(label, error);
    }
  }

  private async reportError(label: string, error: unknown): Promise<void> {
    if (error instanceof LoginCancelledError) return;
    this.log.error(`${label} failed:`, error);

    if (error instanceof NotLoggedInError) {
      const logIn = 'Log In';
      if ((await vscode.window.showWarningMessage(`${error.message}.`, logIn)) === logIn) await this.login();
      return;
    }
    vscode.window.showErrorMessage(`Spotify: ${label} failed. ${describeError(error)}`);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof SpotifyApiError) {
    if (error.isPremiumRequired) return 'This needs a Spotify Premium account.';
    if (error.status === 403) return `Spotify refused the request (${error.message}). Check that your account is added under "User Management" in the Developer Dashboard.`;
    if (error.status === 429) return 'Spotify is rate limiting this app; wait a minute and try again.';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
