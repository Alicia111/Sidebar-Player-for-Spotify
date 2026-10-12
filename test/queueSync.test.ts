import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlaybackQueue, Track } from '../src/api/types.ts';
import { fetchSettledQueue, isQueueLagging } from '../src/state/queueSync.ts';

const track: Track = {
  type: 'track',
  id: 't2',
  name: 'Test Song',
  uri: 'spotify:track:t2',
  duration_ms: 180_000,
  artists: [],
  album: { id: 'a', name: 'Test Album', uri: 'spotify:album:a', images: [], artists: [] },
};

const lagging: PlaybackQueue = { currently_playing: null, queue: [] };
const settled: PlaybackQueue = { currently_playing: track, queue: [] };

describe('isQueueLagging', () => {
  it('flags an empty queue while playback already reports a track', () => {
    assert.equal(isQueueLagging(lagging, 'spotify:track:t2'), true);
  });

  it('accepts a queue that reports a current track', () => {
    assert.equal(isQueueLagging(settled, 'spotify:track:t2'), false);
  });

  it('accepts an empty queue when nothing is playing', () => {
    assert.equal(isQueueLagging(lagging, undefined), false);
  });
});

describe('fetchSettledQueue', () => {
  it('retries until the queue catches up with playback', async () => {
    const responses = [lagging, lagging, settled];
    const sleeps: number[] = [];
    const result = await fetchSettledQueue({
      fetchQueue: async () => responses.shift() ?? settled,
      getPlayingUri: () => track.uri,
      retries: 3,
      delayMs: 700,
      sleep: async (ms) => void sleeps.push(ms),
    });
    assert.deepEqual(result, { queue: settled, isSettled: true });
    assert.deepEqual(sleeps, [700, 700]);
  });

  it('gives up after the retry budget and reports the queue as unsettled', async () => {
    let calls = 0;
    const result = await fetchSettledQueue({
      fetchQueue: async () => (calls++, lagging),
      getPlayingUri: () => track.uri,
      retries: 3,
      delayMs: 700,
      sleep: async () => undefined,
    });
    assert.deepEqual(result, { queue: lagging, isSettled: false });
    assert.equal(calls, 4);
  });

  it('does not retry when nothing is playing', async () => {
    let calls = 0;
    const result = await fetchSettledQueue({
      fetchQueue: async () => (calls++, lagging),
      getPlayingUri: () => undefined,
      retries: 3,
      delayMs: 700,
      sleep: async () => undefined,
    });
    assert.equal(result.isSettled, true);
    assert.equal(calls, 1);
  });
});
