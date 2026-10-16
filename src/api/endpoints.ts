import type { SpotifyClient } from './spotifyClient.ts';
import type {
  Artist,
  ArtistAlbum,
  CurrentUser,
  Device,
  CursorPaging,
  Paging,
  PlaybackQueue,
  PlaybackState,
  PlayHistory,
  PlaylistItem,
  RepeatMode,
  SavedTrack,
  SearchResponse,
  SearchType,
  SimplifiedPlaylist,
  SimplifiedTrack,
} from './types.ts';

// Limits from the February 2026 Web API rules.
export const SEARCH_PAGE_SIZE = 10;
export const LIBRARY_URI_BATCH_SIZE = 40;
const COLLECTION_PAGE_SIZE = 50;
// The February 2026 rules cap an artist's album listing at 10 per page.
export const ARTIST_ALBUMS_PAGE_SIZE = 10;
const ARTIST_ALBUM_GROUPS = 'album,single';
const PLAYLIST_ITEMS_BATCH_SIZE = 100;
// The most the recently played endpoint returns in one request.
const RECENTLY_PLAYED_LIMIT = 50;
const CONTEXT_PATHS: Record<string, string> = { playlist: '/playlists', album: '/albums', artist: '/artists', show: '/shows' };

export interface PlayRequest {
  /** Album, artist or playlist URI to play from. */
  contextUri?: string;
  /** Explicit track list, used when there is no context (e.g. Liked Songs). */
  uris?: string[];
  /** Zero-based start position inside the context or `uris`. */
  offsetPosition?: number;
  /** Start at this item instead; takes precedence over `offsetPosition`. */
  offsetUri?: string;
  deviceId?: string;
}

export interface PageRequest {
  offset: number;
  limit?: number;
}

/** Typed wrappers around the Spotify Web API endpoints this extension uses. */
export class SpotifyApi {
  private readonly client: SpotifyClient;

  constructor(client: SpotifyClient) {
    this.client = client;
  }

  // ---- Player -------------------------------------------------------------

  async getPlaybackState(): Promise<PlaybackState | null> {
    const state = await this.client.request<PlaybackState>('GET', '/me/player', { query: { additional_types: 'episode' } });
    return state ?? null;
  }

  async play(request: PlayRequest = {}): Promise<void> {
    const hasTarget = request.contextUri !== undefined || request.uris !== undefined;
    const body = hasTarget
      ? {
          context_uri: request.contextUri,
          uris: request.uris,
          offset: toPlayOffset(request),
        }
      : undefined;
    await this.client.request('PUT', '/me/player/play', { query: { device_id: request.deviceId }, body });
  }

  async pause(): Promise<void> {
    await this.client.request('PUT', '/me/player/pause');
  }

  async next(): Promise<void> {
    await this.client.request('POST', '/me/player/next');
  }

  async previous(): Promise<void> {
    await this.client.request('POST', '/me/player/previous');
  }

  async seek(positionMs: number): Promise<void> {
    await this.client.request('PUT', '/me/player/seek', { query: { position_ms: Math.max(0, Math.round(positionMs)) } });
  }

  async setVolume(volumePercent: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(volumePercent)));
    await this.client.request('PUT', '/me/player/volume', { query: { volume_percent: clamped } });
  }

  async setShuffle(isEnabled: boolean): Promise<void> {
    await this.client.request('PUT', '/me/player/shuffle', { query: { state: isEnabled } });
  }

  async setRepeat(mode: RepeatMode): Promise<void> {
    await this.client.request('PUT', '/me/player/repeat', { query: { state: mode } });
  }

  async addToQueue(uri: string): Promise<void> {
    await this.client.request('POST', '/me/player/queue', { query: { uri } });
  }

  async getQueue(): Promise<PlaybackQueue> {
    const response = await this.client.request<PlaybackQueue>('GET', '/me/player/queue');
    return { currently_playing: response?.currently_playing ?? null, queue: response?.queue ?? [] };
  }

  /** Human-readable name of a playback context (playlist, album, artist), or undefined for unknown kinds. */
  async getContextName(contextUri: string): Promise<string | undefined> {
    const [, type, id] = contextUri.split(':');
    if (contextUri.endsWith(':collection')) return 'Liked Songs';
    if (!id || !CONTEXT_PATHS[type]) return undefined;
    const response = await this.client.request<{ name?: string }>('GET', `${CONTEXT_PATHS[type]}/${encodeURIComponent(id)}`, {
      query: type === 'playlist' ? { fields: 'name' } : undefined,
    });
    return response?.name;
  }

  async getDevices(): Promise<Device[]> {
    const response = await this.client.request<{ devices: Device[] }>('GET', '/me/player/devices');
    return response?.devices ?? [];
  }

  async transferPlayback(deviceId: string, shouldPlay: boolean): Promise<void> {
    await this.client.request('PUT', '/me/player', { body: { device_ids: [deviceId], play: shouldPlay } });
  }

  /** Most recent first. Needs the `user-read-recently-played` scope (403 without it). */
  async getRecentlyPlayed(): Promise<PlayHistory[]> {
    const response = await this.client.request<CursorPaging<PlayHistory>>('GET', '/me/player/recently-played', {
      query: { limit: RECENTLY_PLAYED_LIMIT },
    });
    return requireBody(response, 'GET /me/player/recently-played').items;
  }

  // ---- Search -------------------------------------------------------------

  async search(query: string, type: SearchType, page: PageRequest): Promise<SearchResponse> {
    const response = await this.client.request<SearchResponse>('GET', '/search', {
      query: { q: query, type, limit: page.limit ?? SEARCH_PAGE_SIZE, offset: page.offset },
    });
    return response ?? {};
  }

  // ---- Artists & albums ---------------------------------------------------

  async getArtist(artistId: string): Promise<Artist> {
    const path = `/artists/${encodeURIComponent(artistId)}`;
    return requireBody(await this.client.request<Artist>('GET', path), `GET ${path}`);
  }

  /** The artist's own albums and singles (not compilations or guest appearances), newest first. */
  async getArtistAlbums(artistId: string, page: PageRequest): Promise<Paging<ArtistAlbum>> {
    const path = `/artists/${encodeURIComponent(artistId)}/albums`;
    const response = await this.client.request<Paging<ArtistAlbum>>('GET', path, {
      query: { include_groups: ARTIST_ALBUM_GROUPS, limit: page.limit ?? ARTIST_ALBUMS_PAGE_SIZE, offset: page.offset },
    });
    return requireBody(response, `GET ${path}`);
  }

  async getAlbumTracks(albumId: string, page: PageRequest): Promise<Paging<SimplifiedTrack>> {
    const path = `/albums/${encodeURIComponent(albumId)}/tracks`;
    const response = await this.client.request<Paging<SimplifiedTrack>>('GET', path, {
      query: { limit: page.limit ?? COLLECTION_PAGE_SIZE, offset: page.offset },
    });
    return requireBody(response, `GET ${path}`);
  }

  // ---- User & playlists ---------------------------------------------------

  async getCurrentUser(): Promise<CurrentUser> {
    return requireBody(await this.client.request<CurrentUser>('GET', '/me'), 'GET /me');
  }

  async getMyPlaylists(page: PageRequest): Promise<Paging<SimplifiedPlaylist>> {
    const response = await this.client.request<Paging<SimplifiedPlaylist>>('GET', '/me/playlists', {
      query: { limit: page.limit ?? COLLECTION_PAGE_SIZE, offset: page.offset },
    });
    return requireBody(response, 'GET /me/playlists');
  }

  /** Only works for playlists the user owns or collaborates on (403 otherwise). */
  async getPlaylistItems(playlistId: string, page: PageRequest): Promise<Paging<PlaylistItem>> {
    const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
    const response = await this.client.request<Paging<PlaylistItem>>('GET', path, {
      query: { limit: page.limit ?? COLLECTION_PAGE_SIZE, offset: page.offset, additional_types: 'track,episode' },
    });
    return requireBody(response, `GET ${path}`);
  }

  async addItemsToPlaylist(playlistId: string, uris: string[]): Promise<void> {
    const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
    for (const batch of chunk(uris, PLAYLIST_ITEMS_BATCH_SIZE)) {
      await this.client.request('POST', path, { body: { uris: batch } });
    }
  }

  /** Removes every occurrence of each URI; the endpoint cannot target a single position. */
  async removeItemsFromPlaylist(playlistId: string, uris: string[]): Promise<void> {
    const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
    for (const batch of chunk(uris, PLAYLIST_ITEMS_BATCH_SIZE)) {
      await this.client.request('DELETE', path, { body: { items: batch.map((uri) => ({ uri })) } });
    }
  }

  async createPlaylist(name: string, description: string): Promise<SimplifiedPlaylist> {
    const response = await this.client.request<SimplifiedPlaylist>('POST', '/me/playlists', {
      body: { name, description, public: false },
    });
    return requireBody(response, 'POST /me/playlists');
  }

  // ---- Library (Liked Songs) ----------------------------------------------

  async getSavedTracks(page: PageRequest): Promise<Paging<SavedTrack>> {
    const response = await this.client.request<Paging<SavedTrack>>('GET', '/me/tracks', {
      query: { limit: page.limit ?? COLLECTION_PAGE_SIZE, offset: page.offset },
    });
    return requireBody(response, 'GET /me/tracks');
  }

  async saveToLibrary(uris: string[]): Promise<void> {
    for (const batch of chunk(uris, LIBRARY_URI_BATCH_SIZE)) {
      await this.client.request('PUT', '/me/library', { query: { uris: batch.join(',') } });
    }
  }

  async removeFromLibrary(uris: string[]): Promise<void> {
    for (const batch of chunk(uris, LIBRARY_URI_BATCH_SIZE)) {
      await this.client.request('DELETE', '/me/library', { query: { uris: batch.join(',') } });
    }
  }

  /** Returns a map from URI to whether it is saved in the user's library. */
  async libraryContains(uris: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    for (const batch of chunk(uris, LIBRARY_URI_BATCH_SIZE)) {
      const flags = await this.client.request<boolean[]>('GET', '/me/library/contains', { query: { uris: batch.join(',') } });
      if (!Array.isArray(flags) || flags.length !== batch.length) {
        throw new Error(`GET /me/library/contains returned ${JSON.stringify(flags)} for ${batch.length} URIs`);
      }
      batch.forEach((uri, index) => result.set(uri, flags[index] === true));
    }
    return result;
  }
}

/** Fetches pages until exhausted or `maxItems` is reached. */
export async function collectPages<T>(
  fetchPage: (page: PageRequest) => Promise<Paging<T>>,
  maxItems: number,
): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let total = 0;
  for (let offset = 0; offset < maxItems; ) {
    const page = await fetchPage({ offset });
    total = page.total;
    items.push(...page.items);
    if (!page.next || page.items.length === 0) break;
    offset += page.items.length;
  }
  return { items: items.slice(0, maxItems), total };
}

export function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    batches.push(values.slice(start, start + size));
  }
  return batches;
}

function toPlayOffset(request: PlayRequest): { uri: string } | { position: number } | undefined {
  if (request.offsetUri !== undefined) return { uri: request.offsetUri };
  if (request.offsetPosition !== undefined) return { position: request.offsetPosition };
  return undefined;
}

function requireBody<T>(body: T | undefined, operation: string): T {
  if (body === undefined) throw new Error(`${operation} returned an empty response`);
  return body;
}
