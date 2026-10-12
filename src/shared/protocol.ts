// Message contract between the extension host and the Now Playing webview.
// Shared by both bundles, so it must stay free of `vscode` and DOM imports.

export type RepeatModeView = 'off' | 'context' | 'track';
export type SearchKind = 'track' | 'album' | 'artist' | 'playlist';

export const SEARCH_KINDS: readonly SearchKind[] = ['track', 'album', 'artist', 'playlist'];

export interface NowPlayingTrackView {
  uri: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  durationMs: number;
  /** Undefined while unknown or for items that can't be liked (local files, episodes). */
  isLiked: boolean | undefined;
}

export interface NowPlayingView {
  track: NowPlayingTrackView | null;
  isPlaying: boolean;
  progressMs: number;
  /** Epoch ms when `progressMs` was sampled, so the webview can advance the bar between polls. */
  sampledAt: number;
  shuffle: boolean;
  repeat: RepeatModeView;
  deviceName: string | null;
  volumePercent: number | null;
}

export interface SearchItemView {
  uri: string;
  kind: SearchKind;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  durationMs?: number;
  isLiked?: boolean;
  /** For tracks: the album to keep playing from once this track ends. */
  contextUri?: string;
}

export interface SearchResultsView {
  items: SearchItemView[];
  hasMore: boolean;
}

export type PlayerCommand =
  | 'login'
  | 'playPause'
  | 'next'
  | 'previous'
  | 'toggleShuffle'
  | 'cycleRepeat'
  | 'toggleLikeCurrent'
  | 'selectDevice'
  | 'showLyrics';

const PLAYER_COMMANDS: readonly PlayerCommand[] = [
  'login',
  'playPause',
  'next',
  'previous',
  'toggleShuffle',
  'cycleRepeat',
  'toggleLikeCurrent',
  'selectDevice',
  'showLyrics',
];

export type ExtensionMessage =
  | { type: 'session'; isLoggedIn: boolean }
  | { type: 'nowPlaying'; state: NowPlayingView | null }
  | { type: 'searchResults'; requestId: number; offset: number; results: SearchResultsView }
  | { type: 'searchError'; requestId: number; message: string }
  | { type: 'likeChanged'; uri: string; isLiked: boolean }
  | { type: 'runSearch'; query: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; command: PlayerCommand }
  | { type: 'seek'; positionMs: number }
  | { type: 'setVolume'; percent: number }
  | { type: 'search'; requestId: number; query: string; kind: SearchKind; offset: number }
  | { type: 'play'; uri: string; contextUri?: string }
  | { type: 'queue'; uri: string }
  | { type: 'setLiked'; uri: string; isLiked: boolean }
  | { type: 'addToPlaylist'; uri: string };

const MAX_QUERY_LENGTH = 200;
const MAX_SEARCH_OFFSET = 1000;
const CONTEXT_URI_PATTERN = /^spotify:(album|artist|playlist):/;
const SPOTIFY_URI_PATTERN = /^spotify:(track|album|artist|playlist|episode):[A-Za-z0-9]{1,64}$/;

export function isSpotifyUri(value: unknown): value is string {
  return typeof value === 'string' && SPOTIFY_URI_PATTERN.test(value);
}

/** Validates an untrusted message from the webview; returns null for anything malformed. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Record<string, unknown>;

  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'command':
      return PLAYER_COMMANDS.includes(message.command as PlayerCommand)
        ? { type: 'command', command: message.command as PlayerCommand }
        : null;
    case 'seek':
      return isFiniteInRange(message.positionMs, 0, Number.MAX_SAFE_INTEGER)
        ? { type: 'seek', positionMs: message.positionMs }
        : null;
    case 'setVolume':
      return isFiniteInRange(message.percent, 0, 100) ? { type: 'setVolume', percent: message.percent } : null;
    case 'search':
      return parseSearchMessage(message);
    case 'play':
      return parsePlayMessage(message);
    case 'queue':
    case 'addToPlaylist':
      return isSpotifyUri(message.uri) ? { type: message.type, uri: message.uri } : null;
    case 'setLiked':
      return isSpotifyUri(message.uri) && typeof message.isLiked === 'boolean'
        ? { type: 'setLiked', uri: message.uri, isLiked: message.isLiked }
        : null;
    default:
      return null;
  }
}

function parsePlayMessage(message: Record<string, unknown>): WebviewMessage | null {
  if (!isSpotifyUri(message.uri)) return null;
  if (message.contextUri === undefined) return { type: 'play', uri: message.uri };
  return isSpotifyUri(message.contextUri) && CONTEXT_URI_PATTERN.test(message.contextUri)
    ? { type: 'play', uri: message.uri, contextUri: message.contextUri }
    : null;
}

function parseSearchMessage(message: Record<string, unknown>): WebviewMessage | null {
  const { requestId, query, kind, offset } = message;
  const isValid =
    Number.isSafeInteger(requestId) &&
    typeof query === 'string' &&
    query.trim().length > 0 &&
    query.length <= MAX_QUERY_LENGTH &&
    SEARCH_KINDS.includes(kind as SearchKind) &&
    Number.isSafeInteger(offset) &&
    isFiniteInRange(offset, 0, MAX_SEARCH_OFFSET);
  return isValid
    ? { type: 'search', requestId: requestId as number, query: query as string, kind: kind as SearchKind, offset: offset as number }
    : null;
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
