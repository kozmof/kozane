import { createHash } from "node:crypto";
import { SNAPSHOT_ETAG_NAMESPACES_MAX } from "../constants.js";
import { databaseSignature } from "./file-signature.js";
import { evict } from "./lru.js";

/**
 * Answering "has this board changed?" without assembling the board.
 *
 * The snapshot endpoint is polled once a second for as long as a tab is open, and almost
 * every poll finds nothing new. The ETag it already sent made those cheap *for the client*
 * — a 304 in place of the whole payload — and left them exactly as expensive for the
 * server, because the tag is a hash of the payload and computing it meant running all nine
 * queries and serializing the result first. Two tabs on an idle workspace is that work
 * twice a second, forever.
 *
 * The tag itself is unchanged, and deliberately: it stays a hash of the bytes, so what a
 * client holds still means "these exact bytes". What is added is a gate in front of the
 * work — the database file's identity, as `databaseSignature` reads it. If the file has
 * not moved since the tag now being offered was computed, that tag is still the right
 * answer, and the queries are skipped outright.
 *
 * Why the file's identity is enough. With `includeScopedFiles: false` — which is what the
 * live endpoint passes — `loadNamespaceSnapshot` is a pure function of the database: nine
 * reads and no filesystem access at all. A byte-identical database therefore cannot produce
 * a different snapshot. `databaseSignature` is `ino:mtimeNs:size` over the main file and
 * its `-wal`, so any commit moves it, whoever made it — this server, another tab, a
 * `kozane card add` in another terminal, a `db import`. That is the same property the tag
 * cache already rests on, and the reason there is no revision counter here to bump: writers
 * that never pass through this process are the ordinary case.
 *
 * The gate fails safe in every direction it can fail. No signature (an in-memory database,
 * a file that cannot be stat'd) means no gate and the full read, which is what happened
 * before. A signature that has moved means the full read. A remembered tag the client is
 * not offering means the full read. It can only ever skip work, never invent an answer.
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
 */
export function unchangedSnapshotEtag(dbUrl: string | null, namespaceId: string): string | null {
  if (!dbUrl) return null;
  const signature = databaseSignature(dbUrl);
  if (!signature) return null;
  const entry = remembered.get(namespaceId);
  return entry && entry.signature === signature ? entry.etag : null;
}

/** Records the tag a full read produced, against the database it was read from. */
export function rememberSnapshotEtag(
  dbUrl: string | null,
  namespaceId: string,
  etag: string,
): void {
  if (!dbUrl) return;
  const signature = databaseSignature(dbUrl);
  if (!signature) return;
  // Deleted first so a revisit moves to the end, which is what makes the eviction below
  // least-recently-used rather than first-seen. Same shape as `touchOrCreate` in `lru.ts`,
  // which cannot be used here because the value depends on a signature read at write time.
  remembered.delete(namespaceId);
  remembered.set(namespaceId, { signature, etag });
  evict(remembered, SNAPSHOT_ETAG_NAMESPACES_MAX);
}

export function _resetSnapshotEtagsForTest(): void {
  remembered.clear();
}
