import { createHash } from "node:crypto";
import { SNAPSHOT_ETAG_NAMESPACES_MAX } from "../constants.js";
import { databaseSignature } from "./file-signature.js";
import { evict, touch } from "./lru.js";

/**
 * Skip snapshot assembly when the database signature and the client's ETag still match the
 * cached values. The ETag remains a hash of the response bytes.
 *
 * With `includeScopedFiles: false` , the live snapshot reads only the database.
 * `databaseSignature` tracks the main file and WAL file so changes from CLI commands and other
 * processes can invalidate the cached result.
 *
 * A missing or changed signature, or a client ETag that does not match, falls back to
 * assembling the full snapshot.
 */

/** The tag for a snapshot's exact bytes. Not a security boundary — it says "these bytes
 *  differ", nothing more. */
export function snapshotEtag(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * Whether `header` names `etag`. A weak validator is accepted because the tag only ever has
 * to answer that question, and `*` matches anything the server would send.
 */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

/** The tag last computed for one namespace, against the database it was computed from. */
type RememberedEtag = { signature: string; etag: string };

/**
 * Keyed by namespace id, in least-recently-used order — a workspace has a handful of
 * namespaces, but nothing here bounds how many, and this map would otherwise be the one
 * structure in the server that grows with what a client asks for.
 */
const remembered = new Map<string, RememberedEtag>();

/**
 * The tag this namespace's snapshot still has, or null when that cannot be established
 * without reading the database.
 *
 * A hit counts as a use, which is what the {@link touch} is for. Recency used to move only
 * in {@link rememberSnapshotEtag}, and that inverted the eviction order this map is built
 * around: an idle board answers every poll from here, recording nothing, while a namespace
 * being written to refreshes its position on each full read. So the entry most worth keeping
 * — the board left open all afternoon, whose whole value is that it never has to be read —
 * was the one aging towards eviction, and the one busy enough to be re-read anyway was safe.
 *
 * A miss touches nothing, for the same reason {@link touch} does not create: an entry absent
 * or stale is about to be replaced by the full read's `rememberSnapshotEtag`, which puts it
 * at the end itself.
 */
export function unchangedSnapshotEtag(dbUrl: string | null, namespaceId: string): string | null {
  if (!dbUrl) return null;
  const signature = databaseSignature(dbUrl);
  if (!signature) return null;
  const entry = remembered.get(namespaceId);
  if (!entry || entry.signature !== signature) return null;
  touch(remembered, namespaceId);
  return entry.etag;
}

/**
 * The database's signature as a full read is about to start, for {@link rememberSnapshotEtag}
 * to compare against once it has finished. Null wherever {@link unchangedSnapshotEtag} would
 * have no gate to offer.
 */
export function snapshotReadSignature(dbUrl: string | null): string | null {
  return dbUrl ? databaseSignature(dbUrl) : null;
}

/**
 * Records the tag a full read produced, against the database it was read from — which is
 * only known when the signature did not move while the read ran. `readFrom` is
 * {@link snapshotReadSignature} taken before the first query.
 *
 * Reading the signature only afterwards, as this did, paired a commit that landed mid-read
 * with a tag computed before it: the next poll found the signature unchanged and answered
 * 304 with the older board, and went on doing so until some unrelated write moved the file.
 * The snapshot's reads are not one transaction, so such a read can also be torn across
 * tables. Either way a moved signature means the tag describes no single state of the
 * database, and nothing is remembered — the next poll reads again.
 */
export function rememberSnapshotEtag(
  dbUrl: string | null,
  namespaceId: string,
  etag: string,
  readFrom: string | null,
): void {
  if (!dbUrl || !readFrom) return;
  const signature = databaseSignature(dbUrl);
  if (signature !== readFrom) return;
  // Deleted first so a revisit moves to the end, which makes the eviction below
  // least-recently-used rather than first-seen. Same shape as `touchOrCreate` in `lru.ts`,
  // which cannot be used here because the value depends on a signature read at write time.
  remembered.delete(namespaceId);
  remembered.set(namespaceId, { signature, etag });
  evict(remembered, SNAPSHOT_ETAG_NAMESPACES_MAX);
}

export function _resetSnapshotEtagsForTest(): void {
  remembered.clear();
}
