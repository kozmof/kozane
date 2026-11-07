/**
 * Maintain least-recently-used order for tag caches. Touch entries by moving them to the end,
 * then evict entries from the front.
 *
 * Support Maps for in-memory storage and objects for JSON serialization.
 */

/**
 * Move an existing key to the end of the map. Leave missing keys absent so a cache lookup
 * cannot create an empty entry.
 */
export function touch<K, V>(map: Map<K, V>, key: K): void {
  const value = map.get(key);
  if (value === undefined) return;
  map.delete(key);
  map.set(key, value);
}

/**
 * Get or create a value and move it to the end of the map. Writing makes it most recently
 * used, so {@link evict} retains it.
 */
export function touchOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  map.delete(key);
  const value = existing ?? make();
  map.set(key, value);
  return value;
}

/** Keep the last `max` entries and remove older ones. Clear the map when `max <= 0`. */
export function evict<K, V>(map: Map<K, V>, max: number): void {
  if (max <= 0) return map.clear();
  for (const key of [...map.keys()].slice(0, -max)) map.delete(key);
}

/**
 * Set a record entry and move it to the end in place.
 *
 * Keys must not be array-index strings. JavaScript enumerates those numerically instead of by
 * insertion order, which would break eviction order. Current callers use UUIDs, `*`, or
 * absolute paths.
 */
export function setLast<V>(entries: Record<string, V>, key: string, value: V): void {
  delete entries[key];
  entries[key] = value;
}

/** Evict older record entries in place, clearing all entries when `max <= 0`. */
export function evictRecord(entries: Record<string, unknown>, max: number): void {
  const keys = Object.keys(entries);
  for (const key of max <= 0 ? keys : keys.slice(0, -max)) delete entries[key];
}
