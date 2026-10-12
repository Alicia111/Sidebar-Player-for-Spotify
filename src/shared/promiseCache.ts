/**
 * Returns the cached promise for `key`, or starts `load` and caches its promise, so concurrent callers
 * share one request. A rejected load is evicted so the next call tries again.
 */
export function getOrLoad<K, V>(cache: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => {
    // Only evict our own entry; a refresh may already have replaced it with a newer load.
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}
