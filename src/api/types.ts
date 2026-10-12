// Only the fields this extension reads. See https://developer.spotify.com/documentation/web-api

export interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SimplifiedArtist {
  id: string;
  name: string;
  uri: string;
}

export interface Artist extends SimplifiedArtist {
  images?: SpotifyImage[];
  genres?: string[];
}

export interface SimplifiedAlbum {
  id: string;
  name: string;
  uri: string;
  images: SpotifyImage[];
  artists: SimplifiedArtist[];
  release_date?: string;
}

export interface Track {
  type: 'track';
  id: string | null;
  name: string;
  uri: string;
  duration_ms: number;
  artists: SimplifiedArtist[];
  album: SimplifiedAlbum;
  is_local?: boolean;
}

export interface Episode {
  type: 'episode';
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  images: SpotifyImage[];
  show?: { name: string };
}

export type PlayableItem = Track | Episode;

export interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}

export type RepeatMode = 'off' | 'track' | 'context';

export interface PlaybackState {
  device: Device;
  shuffle_state: boolean;
  repeat_state: RepeatMode;
  is_playing: boolean;
  progress_ms: number | null;
  item: PlayableItem | null;
  context: { uri: string; type: string } | null;
}

export interface Paging<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}

export interface SimplifiedPlaylist {
  id: string;
  name: string;
  uri: string;
  collaborative: boolean;
  images: SpotifyImage[] | null;
  owner: { id: string; display_name: string | null };
  /** Track count; replaces the deprecated `tracks` field. */
  items?: { total: number };
}

export interface PlaylistItem {
  is_local: boolean;
  /** Null when the track is no longer available. */
  item: PlayableItem | null;
}

export interface PlaybackQueue {
  currently_playing: PlayableItem | null;
  /** Manually queued items first, then the upcoming items of the current context. */
  queue: PlayableItem[];
}

export interface SavedTrack {
  added_at: string;
  track: Track;
}

export interface CurrentUser {
  id: string;
  display_name: string | null;
  product?: string;
}

export type SearchType = 'track' | 'album' | 'artist' | 'playlist';

export interface SearchResponse {
  tracks?: Paging<Track | null>;
  albums?: Paging<SimplifiedAlbum | null>;
  artists?: Paging<Artist | null>;
  playlists?: Paging<SimplifiedPlaylist | null>;
}
