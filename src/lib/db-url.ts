/**
 * Reading a libsql database URL, for the callers that must decide something about a
 * database without opening it.
 *
 * A leaf, and deliberately: `db/client.ts`, `hooks.server.ts` and
 * `lib/server/file-signature.ts` all ask the question below, and the last of those is
 * something `db/internal/config.ts` already imports — so the obvious home beside
 * `getDBURL` would have closed a cycle. Nothing here reaches the filesystem or the
 * database, so nothing can.
 */

/**
 * Whether `url` names a database that lives only in memory.
 *
 * One predicate, because three places were asking the question and two of them were asking
 * a different one. `openDb` matched two exact spellings (`:memory:` and
 * `file::memory:?cache=shared`) and so would not have migrated any other in-memory form;
 * `checkMigrations` in `hooks.server.ts` and `databaseSignature` both used
 * `includes(":memory:")`, which says yes to a file-backed path that merely has those
 * characters in it — `file:/tmp/:memory:/kozane.db` is a real directory name on every
 * platform that allows a colon. Nothing reaches that gap today; that it existed at all is a
 * property of the question being asked three times.
 *
 * The libsql spellings are `:memory:` and a `file::memory:` URL with any query on it, so
 * that is what this matches. Broader than `openDb` was, in the direction that migrates a
 * database rather than leaving one unmigrated; narrower than `includes` was, in the
 * direction that treats a file as a file.
 */
export function isMemoryDbUrl(url: string): boolean {
  return url === ":memory:" || url === "file::memory:" || url.startsWith("file::memory:?");
}
