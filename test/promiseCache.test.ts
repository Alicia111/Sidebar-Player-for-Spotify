import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getOrLoad } from '../src/shared/promiseCache.ts';

describe('getOrLoad', () => {
  it('shares one load between concurrent callers', async () => {
    const cache = new Map<string, Promise<number>>();
    let loads = 0;
    const load = async () => ++loads;
    const [first, second] = await Promise.all([getOrLoad(cache, 'a', load), getOrLoad(cache, 'a', load)]);
    assert.equal(loads, 1);
    assert.equal(first, 1);
    assert.equal(second, 1);
  });

  it('evicts a failed load so the next call retries', async () => {
    const cache = new Map<string, Promise<number>>();
    await assert.rejects(getOrLoad(cache, 'a', () => Promise.reject(new Error('offline'))));
    assert.equal(cache.has('a'), false);
    assert.equal(await getOrLoad(cache, 'a', async () => 7), 7);
  });

  it('does not evict a newer entry when an older load fails', async () => {
    const cache = new Map<string, Promise<number>>();
    let rejectOld!: (error: Error) => void;
    const old = getOrLoad(cache, 'a', () => new Promise<number>((_resolve, reject) => (rejectOld = reject)));
    cache.delete('a');
    const fresh = getOrLoad(cache, 'a', async () => 2);
    rejectOld(new Error('stale'));
    await assert.rejects(old);
    assert.equal(cache.get('a'), fresh);
  });
});
