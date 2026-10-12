import type {
  Artist,
  PlayableItem,
  PlaybackState,
  SearchResponse,
  SimplifiedAlbum,
  SimplifiedPlaylist,
  SpotifyImage,
  Track,
} from '../api/types.ts';
import type { NowPlayingView, SearchItemView, SearchKind, SearchResultsView } from '../shared/protocol.ts';

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
