import { setTimeout as delay } from 'node:timers/promises';
import type { PlaybackQueue } from '../api/types.ts';

/**
 * Right after a track change, Spotify's queue endpoint can briefly report nothing playing
 * while the playback endpoint already shows the new track. Such a response is stale.
 */
export function isQueueLagging(queue: PlaybackQueue, playingUri: string | undefined): boolean {
  return playingUri !== undefined && queue.currently_playing === null;
}

export interface SettledQueueOptions {
  fetchQueue: () => Promise<PlaybackQueue>;
  /** Re-read on every attempt, since polling may update it meanwhile. */
  getPlayingUri: () => string | undefined;
  retries: number;
  delayMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Fetches the queue, retrying briefly while it lags behind playback. */
export async function fetchSettledQueue(options: SettledQueueOptions): Promise<{ queue: PlaybackQueue; isSettled: boolean }> {
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  for (let attempt = 0; ; attempt++) {
    const queue = await options.fetchQueue();
    const isSettled = !isQueueLagging(queue, options.getPlayingUri());
    if (isSettled || attempt >= options.retries) return { queue, isSettled };
    await sleep(options.delayMs);
  }
}

/**
 * How many "next" presses reach `uri`, given where the tree showed it. The queue may have moved on since the
 * tree was drawn, so the expected slot wins when it still matches, otherwise the first match does.
 * Returns undefined when the item is no longer upcoming.
 */
export function countSkipsTo(queue: PlaybackQueue, uri: string, expectedPosition: number): number | undefined {
  if (queue.queue[expectedPosition - 1]?.uri === uri) return expectedPosition;
  const index = queue.queue.findIndex((item) => item.uri === uri);
  return index === -1 ? undefined : index + 1;
}
