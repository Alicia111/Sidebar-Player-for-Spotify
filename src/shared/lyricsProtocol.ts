// Message contract between the extension host and the Lyrics panel webview.

export interface LyricsLineView {
  timeMs: number;
  text: string;
}

export type LyricsView =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'synced'; lines: LyricsLineView[] }
  | { status: 'plain'; text: string }
  | { status: 'instrumental' }
  | { status: 'notFound' }
  | { status: 'unsupported'; reason: string }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

export interface LyricsTrackView {
  uri: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
}

export interface LyricsPlaybackView {
  isPlaying: boolean;
  progressMs: number;
  /** Epoch ms when `progressMs` was sampled. */
  sampledAt: number;
}

export type LyricsExtensionMessage =
  | { type: 'track'; track: LyricsTrackView | null; lyrics: LyricsView }
  | { type: 'playback'; playback: LyricsPlaybackView | null };

export type LyricsWebviewMessage =
  | { type: 'ready' }
  | { type: 'seek'; positionMs: number }
  | { type: 'retry' }
  | { type: 'enableLyrics' };

/** Validates an untrusted message from the lyrics webview; returns null for anything malformed. */
export function parseLyricsWebviewMessage(raw: unknown): LyricsWebviewMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
    case 'retry':
    case 'enableLyrics':
      return { type: message.type };
    case 'seek': {
      const { positionMs } = message;
      return typeof positionMs === 'number' && Number.isFinite(positionMs) && positionMs >= 0
        ? { type: 'seek', positionMs }
        : null;
    }
    default:
      return null;
  }
}
