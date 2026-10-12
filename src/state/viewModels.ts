import type {
  Artist,
  ArtistAlbum,
  PlayableItem,
  PlaybackState,
  SearchResponse,
  SimplifiedAlbum,
  SimplifiedPlaylist,
  SimplifiedTrack,
  SpotifyImage,
  Track,
} from '../api/types.ts';
import type {
  AlbumView,
  ArtistHeaderView,
  NowPlayingView,
  SearchItemView,
  SearchKind,
  SearchResultsView,
} from '../shared/protocol.ts';

// Album art comes largest first; a ~300px image is plenty for a sidebar.
const PREFERRED_IMAGE_WIDTH = 300;

export function pickImageUrl(images: SpotifyImage[] | null | undefined): string | null {
  if (!images || images.length === 0) return null;
  const fitting = images.filter((image) => (image.width ?? 0) >= PREFERRED_IMAGE_WIDTH);
  const chosen = fitting.length > 0 ? fitting[fitting.length - 1] : images[0];
  return chosen.url;
}

export function joinArtistNames(track: Track): string {
  return track.artists.map((artist) => artist.name).join(', ');
}

/** Local files and episodes can't be saved through the library endpoints we use. */
export function isLikeable(item: PlayableItem): boolean {
  return item.type === 'track' && !item.is_local;
}

export function toNowPlayingView(
  playback: PlaybackState | null,
  sampledAt: number,
  likedState: Map<string, boolean>,
): NowPlayingView | null {
  if (!playback) return null;
  const item = playback.item;

  return {
    track: item
      ? {
          uri: item.uri,
          title: item.name,
          subtitle: item.type === 'track' ? joinArtistNames(item) : item.show?.name ?? 'Podcast',
          imageUrl: pickImageUrl(item.type === 'track' ? item.album.images : item.images),
          durationMs: item.duration_ms,
          isLiked: isLikeable(item) ? likedState.get(item.uri) : undefined,
        }
      : null,
    isPlaying: playback.is_playing,
    progressMs: playback.progress_ms ?? 0,
    sampledAt,
    shuffle: playback.shuffle_state,
    repeat: playback.repeat_state,
    deviceName: playback.device?.name ?? null,
    volumePercent: playback.device?.supports_volume === false ? null : playback.device?.volume_percent ?? null,
  };
}

export function toSearchResultsView(kind: SearchKind, response: SearchResponse, likedState: Map<string, boolean>): SearchResultsView {
  const paging = selectPaging(kind, response);
  if (!paging) return { items: [], hasMore: false };

  // Spotify pads search pages with nulls for items it can no longer serve.
  const items = (paging.items as Array<Track | SimplifiedAlbum | Artist | SimplifiedPlaylist | null>)
    .filter((item) => item !== null)
    .map((item) => toSearchItemView(kind, item, likedState));
  return { items, hasMore: paging.next !== null };
}

function selectPaging(kind: SearchKind, response: SearchResponse) {
  switch (kind) {
    case 'track':
      return response.tracks;
    case 'album':
      return response.albums;
    case 'artist':
      return response.artists;
    case 'playlist':
      return response.playlists;
  }
}

function toSearchItemView(
  kind: SearchKind,
  item: Track | SimplifiedAlbum | Artist | SimplifiedPlaylist,
  likedState: Map<string, boolean>,
): SearchItemView {
  switch (kind) {
    case 'track': {
      const track = item as Track;
      return {
        uri: track.uri,
        kind,
        title: track.name,
        subtitle: `${joinArtistNames(track)} · ${track.album.name}`,
        imageUrl: pickImageUrl(track.album.images),
        durationMs: track.duration_ms,
        isLiked: likedState.get(track.uri),
        contextUri: track.album.uri,
      };
    }
    case 'album': {
      const album = item as SimplifiedAlbum;
      const year = album.release_date?.slice(0, 4);
      const artists = album.artists.map((artist) => artist.name).join(', ');
      return { uri: album.uri, kind, title: album.name, subtitle: year ? `${artists} · ${year}` : artists, imageUrl: pickImageUrl(album.images) };
    }
    case 'artist': {
      const artist = item as Artist;
      return { uri: artist.uri, kind, title: artist.name, subtitle: 'Artist', imageUrl: pickImageUrl(artist.images) };
    }
    case 'playlist': {
      const playlist = item as SimplifiedPlaylist;
      return {
        uri: playlist.uri,
        kind,
        title: playlist.name,
        subtitle: `By ${playlist.owner.display_name ?? playlist.owner.id}`,
        imageUrl: pickImageUrl(playlist.images),
      };
    }
  }
}

const ALBUM_TYPE_LABELS: Record<ArtistAlbum['album_type'], string> = { album: 'Album', single: 'Single', compilation: 'Compilation' };

export function toArtistHeaderView(artist: Artist): ArtistHeaderView {
  const genres = (artist.genres ?? []).slice(0, 3).join(', ');
  return { uri: artist.uri, name: artist.name, subtitle: genres || 'Artist', imageUrl: pickImageUrl(artist.images) };
}

export function toAlbumView(album: ArtistAlbum): AlbumView {
  const year = album.release_date?.slice(0, 4);
  const trackCount = `${album.total_tracks} ${album.total_tracks === 1 ? 'track' : 'tracks'}`;
  const parts = [ALBUM_TYPE_LABELS[album.album_type] ?? 'Album', year, trackCount].filter(Boolean);
  return { uri: album.uri, title: album.name, subtitle: parts.join(' · '), imageUrl: pickImageUrl(album.images) };
}

/** Album tracks play inside their album, so playback continues with the next track. */
export function toAlbumTrackViews(tracks: SimplifiedTrack[], albumUri: string, likedState: Map<string, boolean>): SearchItemView[] {
  return tracks.map((track) => ({
    uri: track.uri,
    kind: 'track',
    title: track.name,
    subtitle: track.artists.map((artist) => artist.name).join(', '),
    imageUrl: null,
    durationMs: track.duration_ms,
    isLiked: likedState.get(track.uri),
    contextUri: albumUri,
  }));
}
