/**
 * How much the disposable caches in `.kozane/` will hold before they are rebuilt rather than read.
 *
 * Every one of these bounds a file that owns nothing: `docs/cache.md` is the statement of
 * that, and it makes an oversized or unreadable cache a rebuild rather than an error.
 * The snapshot ETag map is here too — it is not on disk, but it is the same kind of thing: a
 * remembered answer with a ceiling on how many are kept.
 */
import { TAG_SCAN_NODES_MAX } from "./tag.js";

/**
 * How many scopes a gathered tag index keeps. A workspace has few namespaces and the index is
 * looked at one scope at a time, so this is a backstop against a file that grows forever
 * rather than a limit anyone reaches: at a realistic size one scope is around a megabyte.
 */
export const TAG_CACHE_SCOPES_MAX = 16;

/**
 * How many taskspace directories a gathered tag index keeps parsed files for — in this
 * process and in the file on disk alike.
 *
 * One number for both, because they hold the same directories: a memory ceiling below the
 * file's would mean re-importing on every scan what was evicted from one but kept in the
 * other. It was two constants in two modules, each with a comment saying it had to equal the
 * other, which is a convention rather than a guarantee.
 *
 * The precise cleanup is neither of them: a gather across the whole workspace knows every
 * taskspace there is and drops what is not among them. This bounds the case that cannot do
 * that — a workspace only ever looked at one namespace at a time, or a long-lived `kozane open`
 * against taskspaces that come and go — and is set well above the number anyone has, so that
 * eviction is the exception rather than the rhythm.
 */
export const TAG_CACHE_DIRS_MAX = 64;

/**
 * How many parsed files one taskspace directory keeps, in this process and in the file on
 * disk alike — the ceiling {@link TAG_CACHE_DIRS_MAX} does not give.
 *
 * That one bounds how many directories are held and says nothing about how many files any
 * one of them holds, and the two are not the same guarantee. `pruneStale` is the precise
 * cleanup and needs a directory to have been listed to the end before it may call an
 * entry stale — so a taskspace large enough that every scan of it stops at a ceiling is
 * exactly the one nothing prunes, and its entries accumulated across scans for the life of
 * the process. A million-file checkout walked twenty thousand nodes at a time reaches all
 * of it eventually, a different slice each scan, and kept every slice.
 *
 * Set to {@link TAG_SCAN_NODES_MAX} rather than to a smaller round number, and that
 * equality is the whole design: one walk visits at most that many nodes, so it can never
 * write more entries than this keeps, and eviction therefore cannot drop something the
 * current scan has just parsed. A lower ceiling would evict the front of the very walk
 * filling it, and every scan would re-read the files the one before it had already read.
 *
 * Least-recently-used within the directory, and a cache hit touches its entry — which it
 * has to, since a hit writes nothing and would otherwise sink to the front and be evicted
 * ahead of a file that changed. After a scan the order is that scan's walk order, so what
 * is kept is what was most recently seen, and what is dropped is what the taskspace no
 * longer shows.
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
 * How many namespaces the snapshot endpoint remembers an ETag for.
 *
 * The map is keyed by namespace id, and a namespace id arrives in a URL — so without a ceiling
 * it is the one structure in the server whose size a client chooses. A workspace has a
 * handful of namespaces and a browser has one board open at a time, so this is far above what
 * any real use reaches; it is here so that "far above" is a number rather than an
 * assumption. Least-recently-used, so the boards actually being polled are the ones kept.
 */
export const SNAPSHOT_ETAG_NAMESPACES_MAX = 32;
