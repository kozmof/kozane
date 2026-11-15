/** Read-only evidence for interrupted local directory claims. Never replay filesystem work. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { count, eq } from "drizzle-orm";
import type { DB } from "../../db/database.js";
import { localFileOperationTable } from "../../db/schema.js";
import { TASKSPACE_MARKER_FILE } from "../taskspace-marker.js";
import { resolveTaskspacePath } from "./taskspace-path.js";
import { errorCode } from "./fs-paths.js";

export const contentHash = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");
type Operation = typeof localFileOperationTable.$inferSelect;
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
    hashes = JSON.parse(operation.intent).markerHashes;
    if (
      !Array.isArray(hashes) ||
      !hashes.length ||
      hashes.length > 2 ||
      hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
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
    return (hashes as string[]).includes(contentHash(readFileSync(marker)))
      ? "matching-marker"
      : "different-marker";
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
