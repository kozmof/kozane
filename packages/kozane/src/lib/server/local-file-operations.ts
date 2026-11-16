/** Read-only evidence for interrupted local directory claims. Never replay filesystem work. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import type { DB } from "../../db/database.js";
import { localFileOperationTable } from "../../db/schema.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "../taskspace-marker.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import { errorCode, sameEntry } from "./fs-paths.js";

export const contentHash = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");
type Operation = typeof localFileOperationTable.$inferSelect;
type ClaimOptions = { adoptExisting: boolean; parentsInside: boolean; ownIfCreated: boolean };
function markerHashes(taskspaceId: string, namespaceId: string, options: ClaimOptions) {
  const ownership = options.ownIfCreated
    ? options.adoptExisting
      ? [false, true]
      : [true]
    : [false];
  return ownership.map((owned) =>
    contentHash(taskspaceMarkerText(taskspaceId, namespaceId, owned)),
  );
}

export function localClaimIntent(taskspaceId: string, namespaceId: string, options: ClaimOptions) {
  return JSON.stringify({
    ...options,
    markerHashes: markerHashes(taskspaceId, namespaceId, options),
  });
}
export type ClaimObservation =
  | "absent"
  | "directory-without-marker"
  | "matching-marker"
  | "different-marker"
  | "unsafe-path"
  | "invalid-intent"
  | "unreadable";

export function inspectLocalClaim(operation: Operation, workspaceRoot: string): ClaimObservation {
  let hashes: unknown;
  try {
    if (operation.kind !== "taskspace.claim" || operation.version !== 1) return "invalid-intent";
    const intent = JSON.parse(operation.intent);
    if (
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      Object.keys(intent).length !== 4 ||
      ["adoptExisting", "parentsInside", "ownIfCreated"].some(
        (key) => typeof intent[key] !== "boolean",
      )
    )
      return "invalid-intent";
    hashes = intent.markerHashes;
    const expected = markerHashes(operation.taskspaceId, operation.namespaceId, intent);
    if (
      !Array.isArray(hashes) ||
      !hashes.length ||
      hashes.length !== expected.length ||
      new Set(hashes).size !== hashes.length ||
      hashes.some((hash) => typeof hash !== "string" || !expected.includes(hash))
    )
      return "invalid-intent";
  } catch {
    return "invalid-intent";
  }
  const target = resolveTaskspacePath(operation.path, operation.pathKind, workspaceRoot);
  if (!target) return "unsafe-path";
  try {
    // Refuse symlinks in every component. Interrupted work does not authorize following
    // replacement directories to inspect unrelated files.
    const components: string[] = [];
    for (let path = resolve(target); ; path = dirname(path)) {
      components.unshift(path);
      if (dirname(path) === path) break;
    }
    for (const path of components) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe-path";
    }
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    const marker = join(target, TASKSPACE_MARKER_FILE);
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return "different-marker";
    const fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > 65536 || !sameEntry(stat, opened))
        return "different-marker";
      // Bound the read even if another process grows or replaces the marker during inspection.
      const bytes = Buffer.alloc(65537);
      let size = 0;
      while (size < bytes.length) {
        const read = readSync(fd, bytes, size, bytes.length - size, null);
        if (!read) break;
        size += read;
      }
      return size <= 65536 && (hashes as string[]).includes(contentHash(bytes.subarray(0, size)))
        ? "matching-marker"
        : "different-marker";
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "directory-without-marker" : "unreadable";
  }
}

/** Bounded diagnostics; a matching marker remains pending until explicitly reconciled. */
export async function pendingLocalClaims(db: DB, workspaceRoot: string) {
  const pending = eq(localFileOperationTable.state, "pending");
  const [row] = await db.select({ total: count() }).from(localFileOperationTable).where(pending);
  const operations = await db
    .select()
    .from(localFileOperationTable)
    .where(pending)
    .orderBy(localFileOperationTable.createdAt, localFileOperationTable.id)
    .limit(5);
  return {
    total: row?.total ?? 0,
    named: operations.map((operation) => ({
      id: operation.id,
      taskspaceId: operation.taskspaceId,
      observation: inspectLocalClaim(operation, workspaceRoot),
    })),
  };
}
