import { createHash } from "node:crypto";
import { SNAPSHOT_ETAG_NAMESPACES_MAX } from "../constants.js";
import { databaseSignature } from "./file-signature.js";
import { evict, touch } from "./lru.js";

/**
 * Skip snapshot assembly when the database signature and the client's ETag still match the
 * cached values. The ETag remains a hash of the response bytes.
 *
 * With `includeScopedFiles: false`, the live snapshot reads only the database.
 * `databaseSignature` tracks the main file and WAL file so changes from CLI commands and other
 * processes can invalidate the cached result.
 *
 * A missing or changed signature, or a client ETag that does not match, falls back to
 * assembling the full snapshot.
 */

/** Hash the snapshot bytes for change detection. This tag is not a security boundary. */
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
 * Namespace ETags in least-recently-used order. Bound the map because clients choose
 * namespace IDs through request URLs.
 */
const remembered = new Map<string, RememberedEtag>();

/**
 * Return the cached ETag when the database signature still matches, or null when a full read
 * is needed. Touch cache hits so frequently polled unchanged boards remain recent.
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
 * Cache the ETag only if the database signature remained unchanged throughout the snapshot
 * read. `readFrom` is captured before the first query.
 *
 * A concurrent commit can leave the multi-query snapshot inconsistent, so skip caching it and
 * let the next poll reread.
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
