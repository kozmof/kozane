/**
 * How much the disposable caches in `.kozane/` will hold before they are rebuilt rather than read.
 *
 * Every one of these bounds a file that owns nothing: `docs/cache.md` is the statement of
 * that, and it is what makes an oversized or unreadable cache a rebuild rather than an error.
 * The snapshot ETag map is here too — it is not on disk, but it is the same kind of thing: a
 * remembered answer with a ceiling on how many are kept.
 */
import { TAG_SCAN_NODES_MAX } from "./tag.js";

/**
 * How many scopes a gathered tag index keeps. A workspace has few projects and the index is
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
 * that — a workspace only ever looked at one project at a time, or a long-lived `kozane open`
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
 * cleanup and needs a directory to have been listed *to the end* before it may call an
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
 * Least-recently-used within the directory, and a cache *hit* touches its entry — which it
 * has to, since a hit writes nothing and would otherwise sink to the front and be evicted
 * ahead of a file that changed. After a scan the order is that scan's walk order, so what
 * is kept is what was most recently seen, and what is dropped is what the taskspace no
 * longer shows.
 */
export const TAG_CACHE_FILES_MAX = TAG_SCAN_NODES_MAX;

/**
 * How large the gathered tag index on disk may be before it is ignored and rebuilt.
 *
 * The one ceiling the cache did not have. {@link TAG_CACHE_SCOPES_MAX} and
 * {@link TAG_CACHE_DIRS_MAX} bound how many entries it keeps and neither bounds how large
 * one is: a scope holds every tagged card in the workspace with a line of each, and a
 * directory holds every parsed file with the tags of each, so the file's size follows the
 * workspace's rather than anything set here.
 *
 * It has to be bounded because of where it is read. `readTagCache` is `readFileSync` and
 * `JSON.parse` on the path a page load and a `kozane tag` run wait on — the same synchronous
 * blocking {@link TAG_SCAN_WORKSPACE_BYTES_MAX} exists to bound for the walk, which was
 * bounded while the read of what the walk produced was not. A cache large enough to cost
 * more to read than the gather it saves is worse than no cache.
 *
 * Ignored and rebuilt rather than trimmed, because trimming means deciding which scope or
 * which directory to drop while holding the parsed file this is trying to avoid parsing.
 * Rebuilding writes a smaller file only if the workspace has shrunk, so a workspace that is
 * genuinely this size pays a cold read every time — which is the honest outcome, and the
 * signal that {@code ?files=0} or a narrower project is the answer rather than a bigger
 * ceiling.
 *
 * Set above what a realistic workspace reaches and no further, which is a smaller number than
 * it looks: {@link TAG_CACHE_SCOPES_MAX} scopes at the megabyte a scope is reckoned at is
 * sixteen, and this is that with room to spare. It was four times higher, on the reasoning
 * that a ceiling should be generous — but generosity is the wrong direction for this one.
 * Every byte under it is a byte that may be read synchronously while a page load waits, so
 * the ceiling *is* the worst case it permits, and setting it far above the workspaces that
 * exist only widens the window in which the cache costs more than the gather it replaces.
 * A workspace that genuinely exceeds this is told the truth by paying a cold read, and that
 * is a better answer than a hundred-millisecond stall on every navigation.
 *
 * Checked when the file is written as well as when it is read, and the write side is what
 * makes "pays a cold read every time" true rather than "pays a cold read *and* a wasted
 * write every time". Read alone, the ceiling refuses a file that the very next gather
 * serializes and lays down again — megabytes through `JSON.stringify` and out to disk, once
 * per page load, to produce a file this build has already decided it will never read. A
 * cache too large to be read is not a cache, so it is not written either.
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
 * How many projects the snapshot endpoint remembers an ETag for.
 *
 * The map is keyed by project id, and a project id arrives in a URL — so without a ceiling
 * it is the one structure in the server whose size a client chooses. A workspace has a
 * handful of projects and a browser has one board open at a time, so this is far above what
 * any real use reaches; it is here so that "far above" is a number rather than an
 * assumption. Least-recently-used, so the boards actually being polled are the ones kept.
 */
export const SNAPSHOT_ETAG_PROJECTS_MAX = 32;
