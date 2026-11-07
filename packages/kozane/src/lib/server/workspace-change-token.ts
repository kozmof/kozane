import { createHash, randomUUID } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import type { DB } from "../../db/database.js";
import { nodeCommitRevision } from "../../db/tx.js";
import { dbPathFromUrl, isMemoryDbUrl } from "../db-url.js";
import { UnavailableError } from "../../services/errors.js";
function metadata(path: string): string | null {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}` : null;
}
function bytes(path: string, length: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(length);
    const count = readSync(fd, buffer, 0, length, 0);
    if (count < length) throw new Error("Incomplete database metadata");
    return buffer;
  } finally {
    closeSync(fd);
  }
}
/** Opaque workspace token. Read failures never masquerade as absent sidecars. */
export function workspaceChangeToken(db: DB, url: string | null): string {
  try {
    const state = nodeCommitRevision(db);
    let signature = "memory";
    if (url !== null && !isMemoryDbUrl(url)) {
      const path = dbPathFromUrl(url);
      if (!path) throw new Error("Unsupported database location");
      const main = metadata(path);
      if (!main) throw new Error("Database file is missing");
      const header = bytes(path, 20);
      if (!header) throw new Error("Database header is missing");
      const wal = metadata(path + "-wal");
      const shm = bytes(path + "-shm", 48);
      // Rollback journals cannot provide a reliable unchanged token from timestamps alone.
      const conservative =
        header[18] !== 2 || header[19] !== 2 || (wal !== null && shm === null) ? randomUUID() : "";
      signature = `${main}|${wal ?? "absent"}|${shm?.toString("hex") ?? "absent"}|${conservative}`;
    }
    return createHash("sha256")
      .update(`${state.nonce}:${state.revision}|${signature}`)
      .digest("base64url");
  } catch (cause) {
    throw new UnavailableError("Unable to check workspace changes", { cause });
  }
}
