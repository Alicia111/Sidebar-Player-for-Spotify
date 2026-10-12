import { formatDuration } from '../shared/format.ts';
import type { NowPlayingView, PlayerCommand } from '../shared/protocol.ts';
import { LISTEN_ON_SPOTIFY_LABEL, toSpotifyWebUrl } from '../shared/spotifyLinks.ts';
import { send } from './bridge.ts';
import { coverImage, h, iconButton, setIcon, icon } from './dom.ts';

const PROGRESS_TICK_MS = 500;

/** The now-playing card: cover, title, transport controls, progress and volume. */
export class PlayerPanel {
  readonly element = h('section', { className: 'player' });
  private state: NowPlayingView | null = null;
  private isDraggingProgress = false;
  private progressTimer: ReturnType<typeof setInterval> | undefined;

  private readonly coverSlot = h('div', { className: 'cover-slot' });
  private readonly title = h('div', { className: 'track-title' });
  private readonly subtitle = h('div', { className: 'track-subtitle' });
  private readonly deviceLabel = h('button', { className: 'device-label link-button', attributes: { type: 'button' } });
  private readonly elapsed = h('span', { className: 'time' });
  private readonly duration = h('span', { className: 'time' });
  private readonly progress = h('input', { className: 'slider progress', attributes: { type: 'range', min: '0', max: '1000', 'aria-label': 'Seek' } });
  private readonly volume = h('input', { className: 'slider volume', attributes: { type: 'range', min: '0', max: '100', 'aria-label': 'Volume' } });
  private readonly volumeRow = h('div', { className: 'volume-row' }, [icon('volume'), this.volume]);
  private readonly shuffleButton = this.commandButton('shuffle', 'Shuffle', 'toggleShuffle');
  private readonly previousButton = this.commandButton('previous', 'Previous', 'previous');
  private readonly playButton = this.commandButton('play', 'Play', 'playPause', 'play-button');
  private readonly nextButton = this.commandButton('next', 'Next', 'next');
  private readonly repeatButton = this.commandButton('repeat', 'Repeat', 'cycleRepeat');
  private readonly likeButton = this.commandButton('heart', 'Save to Liked Songs', 'toggleLikeCurrent');
  private readonly lyricsButton = this.commandButton('lyrics', 'Show lyrics', 'showLyrics');
  private readonly spotifyLinkButton = iconButton({
    icon: 'openExternal',
    label: LISTEN_ON_SPOTIFY_LABEL,
    onClick: () => {
      const uri = this.state?.track?.uri;
      if (uri) send({ type: 'openInSpotify', uri });
    },
  });
  private readonly idleNotice = h('div', { className: 'idle-notice' });

  constructor() {
    this.deviceLabel.addEventListener('click', () => send({ type: 'command', command: 'selectDevice' }));
    this.bindProgress();
    this.volume.addEventListener('change', () => send({ type: 'setVolume', percent: Number(this.volume.value) }));

    const idleButton = h('button', { className: 'primary-button', text: 'Choose a device', attributes: { type: 'button' } });
    idleButton.addEventListener('click', () => send({ type: 'command', command: 'selectDevice' }));
    this.idleNotice.append(h('p', { text: 'Nothing is playing. Start Spotify on any device, or pick one here.' }), idleButton);

    this.element.append(
      this.idleNotice,
      h('div', { className: 'now-playing' }, [
        this.coverSlot,
        h('div', { className: 'track-meta' }, [this.title, this.subtitle, this.deviceLabel]),
        this.likeButton,
        this.spotifyLinkButton,
      ]),
      h('div', { className: 'progress-row' }, [this.elapsed, this.progress, this.duration]),
      h('div', { className: 'controls' }, [this.shuffleButton, this.previousButton, this.playButton, this.nextButton, this.repeatButton, this.lyricsButton]),
      this.volumeRow,
    );
    this.render();
  }

  update(state: NowPlayingView | null): void {
    const previousImage = this.state?.track?.imageUrl;
    this.state = state;
    if (state?.track?.imageUrl !== previousImage || this.coverSlot.childElementCount === 0) {
      this.coverSlot.replaceChildren(coverImage(state?.track?.imageUrl ?? null, 'cover'));
    }
    this.render();
    this.syncProgressTimer();
  }

  /** The position only moves while playing, so a paused player needs no ticking. */
  private syncProgressTimer(): void {
    const shouldTick = this.state?.isPlaying === true && this.state.track !== null;
    if (shouldTick && this.progressTimer === undefined) {
      this.progressTimer = setInterval(() => this.renderProgress(), PROGRESS_TICK_MS);
    } else if (!shouldTick && this.progressTimer !== undefined) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
  }

  private render(): void {
    const state = this.state;
    const track = state?.track ?? null;
    this.element.classList.toggle('is-idle', !track);
    this.idleNotice.hidden = track !== null;

    this.title.textContent = track?.title ?? '';
    this.title.title = track?.title ?? '';
    this.subtitle.textContent = track?.subtitle ?? '';
    this.deviceLabel.textContent = state?.deviceName ? `On ${state.deviceName}` : 'No active device';
    this.deviceLabel.title = 'Switch playback device';

    setIcon(this.playButton, state?.isPlaying ? 'pause' : 'play');
    this.playButton.title = state?.isPlaying ? 'Pause' : 'Play';

    this.shuffleButton.classList.toggle('is-active', state?.shuffle === true);
    const repeat = state?.repeat ?? 'off';
    setIcon(this.repeatButton, repeat === 'track' ? 'repeatOne' : 'repeat');
    this.repeatButton.classList.toggle('is-active', repeat !== 'off');
    this.repeatButton.title = { off: 'Repeat: off', context: 'Repeat: all', track: 'Repeat: one' }[repeat];

    this.spotifyLinkButton.hidden = !track || toSpotifyWebUrl(track.uri) === undefined;

    const isLiked = track?.isLiked;
    this.likeButton.hidden = isLiked === undefined;
    setIcon(this.likeButton, isLiked ? 'heartFilled' : 'heart');
    this.likeButton.classList.toggle('is-active', isLiked === true);
    this.likeButton.title = isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs';

    this.volumeRow.hidden = state?.volumePercent === null || state?.volumePercent === undefined;
    if (state?.volumePercent !== null && state?.volumePercent !== undefined && document.activeElement !== this.volume) {
      this.volume.value = String(state.volumePercent);
    }
    this.renderProgress();
  }

  private renderProgress(): void {
    const track = this.state?.track;
    if (!this.state || !track || this.isDraggingProgress) return;
    const positionMs = this.estimatedPositionMs(this.state, track.durationMs);
    this.elapsed.textContent = formatDuration(positionMs);
    this.duration.textContent = formatDuration(track.durationMs);
    this.progress.value = String(track.durationMs > 0 ? Math.round((positionMs / track.durationMs) * 1000) : 0);
  }

  private estimatedPositionMs(state: NowPlayingView, durationMs: number): number {
    const drift = state.isPlaying ? Date.now() - state.sampledAt : 0;
    return Math.min(durationMs, state.progressMs + drift);
  }

  private bindProgress(): void {
    this.progress.addEventListener('input', () => {
      this.isDraggingProgress = true;
      const durationMs = this.state?.track?.durationMs ?? 0;
      this.elapsed.textContent = formatDuration((Number(this.progress.value) / 1000) * durationMs);
    });
    this.progress.addEventListener('change', () => {
      this.isDraggingProgress = false;
      const durationMs = this.state?.track?.durationMs ?? 0;
      send({ type: 'seek', positionMs: Math.round((Number(this.progress.value) / 1000) * durationMs) });
    });
  }

  private commandButton(iconName: Parameters<typeof iconButton>[0]['icon'], label: string, command: PlayerCommand, className?: string) {
    return iconButton({ icon: iconName, label, className, onClick: () => send({ type: 'command', command }) });
  }
}
