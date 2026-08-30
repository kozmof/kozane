/**
 * Least-recently-used bookkeeping over insertion order, for the two stores behind the tag
 * index: the parsed files this process holds (`taskspace-tags.ts`) and the gather kept on
 * disk (`tag-cache.ts`).
 *
 * Here because they had a copy each, and the copies were the same four lines: delete the key
 * before setting it so a revisit moves to the end, then drop whatever sits before the last
 * `max`. Written out twice they were two places to get "before the last" off by one, and the
 * comment in each said the other one did it the same way — which is a convention, not a
 * guarantee. The ceilings they use had the same problem and are now
 * {@link TAG_CACHE_DIRS_MAX}, one number rather than two kept equal by a note.
 *
 * Both containers are here, and both are needed rather than one being a tidier choice than
 * the other: the in-process store is a `Map` keyed by anything, while the persisted one is a
 * plain object, because it is written to JSON and read back as one. They are the same policy
 * over the two things insertion order means in JavaScript.
 */

/**
 * Moves `key` to the end of `map`, if it is there at all.
 *
 * Absent keys are left absent rather than created. A store that answered entirely from what
 * it already held writes nothing, and would otherwise never mark itself as used — the entry
 * nobody has had to touch is exactly the one worth keeping — but creating one on the way past
 * leaves an empty record for something that was never successfully read, which a later export
 * cannot tell apart from a real, empty result.
 */
export function touch<K, V>(map: Map<K, V>, key: K): void {
  const value = map.get(key);
  if (value === undefined) return;
  map.delete(key);
  map.set(key, value);
}

/**
 * `map.get(key)`, creating it with `make` if absent, and either way moved to the end.
 *
 * The pair to {@link touch} for the writing path: what is being written to is by definition
 * the most recently used, and so is never what {@link evict} drops.
 */
export function touchOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  map.delete(key);
  const value = existing ?? make();
  map.set(key, value);
  return value;
}

/**
 * Drops all but the last `max` entries — the ones least recently touched.
 *
 * `max <= 0` clears the map, which is what "keep none of them" means. Spelled out because
 * `slice(0, -max)` does not mean it: `-0` is `0`, so the negative-offset form quietly becomes
 * `slice(0, 0)` and keeps *everything* — a ceiling of zero that evicts nothing is the one
 * value where this function would do the opposite of what it was asked.
 */
export function evict<K, V>(map: Map<K, V>, max: number): void {
  if (max <= 0) return map.clear();
  for (const key of [...map.keys()].slice(0, -max)) map.delete(key);
}

/**
 * The same two operations over a plain object, whose keys carry insertion order the same way
 * a `Map`'s do — for the record that is serialized to JSON, where a `Map` is not.
 *
 * Sets `key` at the end, deleting it first so that a key already present moves there rather
 * than keeping the position it first took. In place, like the two above: the caller owns the
 * record it is building, and a fresh copy per key would be a copy of everything kept so far,
 * once per key kept.
 *
 * ## The one kind of key this does not work for
 *
 * An object's keys are only in insertion order while none of them is an array index — a
 * canonical non-negative integer below 2³²−1. Those come first and in numeric order however
 * they were set, so `{"b": …}` then `{"2": …}` then `{"1": …}` enumerates `1, 2, b`. Written
 * to JSON and read back the order is the same, because it is a property of the object rather
 * than of the serialization.
 *
 * So a record keyed on integer-like strings would take these operations without complaint and
 * evict in an order nobody chose — the least-recently-used entry kept and a fresh one dropped,
 * with the file still valid and every test still passing. It is stated here rather than
 * guarded because the guard would run on every key of every save, and because both callers are
 * safe by construction rather than by luck: `tag-cache.ts` keys its scopes on a uuidv7 project
 * id or the literal `*`, and its files on an absolute directory path. Neither can be an
 * integer. A third caller keyed on something countable — a row number, a port, an index — is
 * the case to look for.
 */
export function setLast<V>(entries: Record<string, V>, key: string, value: V): void {
  delete entries[key];
  entries[key] = value;
}

/** {@link evict} for such a record, in place — including its answer for `max <= 0`. */
export function evictRecord(entries: Record<string, unknown>, max: number): void {
  const keys = Object.keys(entries);
  for (const key of max <= 0 ? keys : keys.slice(0, -max)) delete entries[key];
}
