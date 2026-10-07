/**
 * Size limits for disposable caches. Rebuild missing, invalid, or oversized cache files. The
 * in-memory snapshot ETag map has a separate entry limit.
 */
import { TAG_SCAN_NODES_MAX } from "./tag.js";

/**
 * Maximum scopes retained in the tag-index cache. Bound the cache file's growth as namespaces
 * change.
 */
export const TAG_CACHE_SCOPES_MAX = 16;

/**
 * Maximum taskspace directories retained in memory and on disk. Share the limit so a scan
 * does not repeatedly restore entries evicted only from memory.
 *
 * Workspace-wide gathers also remove directories no longer in the workspace. This ceiling
 * bounds caches used only through narrower gathers.
 */
export const TAG_CACHE_DIRS_MAX = 64;

/**
 * Maximum parsed files cached per taskspace, shared by memory and disk stores.
 *
 * Incomplete scans cannot reliably prune stale files, so cap the cache independently of
 * cleanup. Match {@link TAG_SCAN_NODES_MAX} to retain a complete scan's entries. Evict
 * least-recently-used entries and refresh recency on cache hits.
 */
export const TAG_CACHE_FILES_MAX = TAG_SCAN_NODES_MAX;

/**
 * Maximum size of the saved tag index. Ignore an oversized cache and rebuild the index.
 *
 * Entry-count limits do not bound the size of each scope or directory record. This byte limit
 * bounds the synchronous file read and JSON parsing that page loads and CLI commands wait for.
 *
 * Apply the limit on writes too, so a gather cannot repeatedly serialize and save a cache that
 * the next read will reject. A workspace whose index remains over the limit requires a fresh
 * gather each time. Narrowing the namespace or disabling file scanning with `?files=0` can
 * reduce that work.
 */
export const TAG_CACHE_BYTES_MAX = 16 * 1024 * 1024;

/** Maximum persisted semantic snapshot for the treemap. Like the tag cache, this is read
 * synchronously on a page load, so an oversized result is better rebuilt than stored as a
 * permanent navigation stall. */

/** Maximum persisted semantic snapshot for the treemap. Like the tag cache, this is read
 * synchronously on a page load, so an oversized result is better rebuilt than stored as a
 * permanent navigation stall. */
export const TREEMAP_CACHE_BYTES_MAX = 16 * 1024 * 1024;

/**
 * Maximum namespace ETags retained in least-recently-used order. Bound the map because
 * namespace IDs arrive in request URLs.
 */
export const SNAPSHOT_ETAG_NAMESPACES_MAX = 32;
