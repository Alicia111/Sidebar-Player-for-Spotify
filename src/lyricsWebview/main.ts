import { findActiveLineIndex } from '../lyrics/lrc.ts';
import type { LyricsExtensionMessage, LyricsPlaybackView, LyricsView, LyricsWebviewMessage } from '../shared/lyricsProtocol.ts';
import { coverImage, h } from '../webview/dom.ts';
import { vscodeApi } from '../webview/vscodeApi.ts';

const HIGHLIGHT_TICK_MS = 200;
// After the user scrolls by hand, leave the scroll position alone for a while.
const MANUAL_SCROLL_GRACE_MS = 4000;
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function send(message: LyricsWebviewMessage): void {
  vscodeApi.postMessage(message);
}

const app = document.getElementById('app');
if (!app) throw new Error('Lyrics webview is missing its #app root element');

const coverSlot = h('div', { className: 'cover-slot' });
const title = h('h1', { className: 'title' });
const subtitle = h('div', { className: 'subtitle' });
const body = h('section', { className: 'lyrics', attributes: { 'aria-live': 'off' } });
const footer = h('footer', { className: 'credit', text: 'Lyrics from LRCLIB (lrclib.net)' });
app.append(h('header', { className: 'header' }, [coverSlot, h('div', { className: 'heading' }, [title, subtitle])]), body, footer);

let playback: LyricsPlaybackView | null = null;
let syncedLines: { timeMs: number; text: string }[] = [];
let lineElements: HTMLElement[] = [];
let activeIndex = -1;
let lastManualScrollAt = 0;
let renderedImageUrl: string | null | undefined;
let highlightTimer: ReturnType<typeof setInterval> | undefined;

window.addEventListener('wheel', () => (lastManualScrollAt = Date.now()), { passive: true });
window.addEventListener('touchmove', () => (lastManualScrollAt = Date.now()), { passive: true });

window.addEventListener('message', (event: MessageEvent<LyricsExtensionMessage>) => {
  const message = event.data;
  if (message.type === 'track') {
    renderHeader(message.track);
    renderLyrics(message.lyrics);
  } else if (message.type === 'playback') {
    playback = message.playback;
    updateHighlight();
  }
  syncHighlightTimer();
});

send({ type: 'ready' });

function renderHeader(track: { title: string; subtitle: string; imageUrl: string | null } | null): void {
  title.textContent = track?.title ?? 'Nothing playing';
  subtitle.textContent = track?.subtitle ?? 'Start something in Spotify and the lyrics will follow.';
  const imageUrl = track?.imageUrl ?? null;
  if (imageUrl !== renderedImageUrl) {
    renderedImageUrl = imageUrl;
    coverSlot.replaceChildren(coverImage(imageUrl, 'cover'));
  }
}

function renderLyrics(view: LyricsView): void {
  syncedLines = [];
  lineElements = [];
  activeIndex = -1;
  body.classList.toggle('is-synced', view.status === 'synced');

  switch (view.status) {
    case 'synced':
      syncedLines = view.lines;
      lineElements = view.lines.map((line) => renderSyncedLine(line.timeMs, line.text));
      body.replaceChildren(...lineElements);
      window.scrollTo({ top: 0 });
      updateHighlight();
      return;
    case 'plain':
      body.replaceChildren(...view.text.split(/\r?\n/).map((text) => h('p', { className: 'line', text: text || ' ' })));
      window.scrollTo({ top: 0 });
      return;
    case 'idle':
      body.replaceChildren();
      return;
    case 'loading':
      body.replaceChildren(notice('Looking for lyrics…'));
      return;
    case 'instrumental':
      body.replaceChildren(notice('♪ Instrumental ♪'));
      return;
    case 'notFound':
      body.replaceChildren(notice('No lyrics found for this track.'), actionButton('Try again', { type: 'retry' }));
      return;
    case 'unsupported':
      body.replaceChildren(notice(view.reason));
      return;
    case 'disabled':
      body.replaceChildren(
        notice('Lyrics are turned off. Turning them on sends the track title and artist to lrclib.net.'),
        actionButton('Turn on lyrics', { type: 'enableLyrics' }),
      );
      return;
    case 'error':
      body.replaceChildren(notice(`Couldn't load lyrics: ${view.message}`), actionButton('Try again', { type: 'retry' }));
      return;
  }
}

function renderSyncedLine(timeMs: number, text: string): HTMLElement {
  const line = h('p', { className: 'line', text: text || '♪', attributes: { tabindex: '0', role: 'button' } });
  const seek = () => send({ type: 'seek', positionMs: timeMs });
  line.addEventListener('click', seek);
  line.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      seek();
    }
  });
  return line;
}

/** Only synced lyrics of a playing track move on their own; everything else needs no ticking. */
function syncHighlightTimer(): void {
  const shouldTick = playback?.isPlaying === true && syncedLines.length > 0;
  if (shouldTick && highlightTimer === undefined) {
    highlightTimer = setInterval(updateHighlight, HIGHLIGHT_TICK_MS);
  } else if (!shouldTick && highlightTimer !== undefined) {
    clearInterval(highlightTimer);
    highlightTimer = undefined;
  }
}

function updateHighlight(): void {
  if (syncedLines.length === 0 || !playback) return;
  const drift = playback.isPlaying ? Date.now() - playback.sampledAt : 0;
  const nextIndex = findActiveLineIndex(syncedLines, playback.progressMs + drift);
  if (nextIndex === activeIndex) return;

  lineElements[activeIndex]?.classList.remove('is-active');
  activeIndex = nextIndex;
  const activeLine = lineElements[activeIndex];
  if (!activeLine) return;
  activeLine.classList.add('is-active');
  lineElements.forEach((element, index) => element.classList.toggle('is-past', index < activeIndex));
  if (Date.now() - lastManualScrollAt > MANUAL_SCROLL_GRACE_MS) {
    activeLine.scrollIntoView({ block: 'center', behavior: prefersReducedMotion.matches ? 'auto' : 'smooth' });
  }
}

function notice(text: string): HTMLElement {
  return h('p', { className: 'notice', text });
}

function actionButton(label: string, message: LyricsWebviewMessage): HTMLElement {
  const button = h('button', { className: 'primary-button', text: label, attributes: { type: 'button' } });
  button.addEventListener('click', () => send(message));
  return button;
}
