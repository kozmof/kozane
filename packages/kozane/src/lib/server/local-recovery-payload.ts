/** Immutable local snapshot files. Catalog registration is required before filesystem publication. */
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  describeLocalRecoverySnapshot,
  inspectLocalRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  validateStoredLocalRecoveryCheckpoint,
  parseLocalRecoveryIdentity,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpoint,
  type LocalRecoveryCheckpointKey,
  type LocalRecoverySnapshot,
} from "@kozane/core/recovery";

export class LocalRecoveryPayloadError extends Error {
  override readonly name = "LocalRecoveryPayloadError";
}
class UnsafePayloadPath extends Error {}
export type LocalRecoveryPayloadEvidence =
  | "absent"
  | "matching-content"
  | "different-content"
  | "unsafe-path"
  | "unreadable";
const components = [".kozane", "recovery", "checkpoints"];
const code = (error: unknown) => (error instanceof Error && "code" in error ? error.code : null);
const paths = (directory: string, checkpoint: LocalRecoveryCheckpoint) => ({
  published: join(directory, `${checkpoint.sha256}.json`),
  temporary: join(directory, `.pending-${checkpoint.sha256}.json`),
});
async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const handle = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function directory(root: string, create: boolean) {
  let path = await fs.realpath(root);
  for (const component of components) {
    path = join(path, component);
    let created = false;
    if (create) {
      try {
        await fs.mkdir(path);
        created = true;
      } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
    }
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new UnsafePayloadPath("Unsafe checkpoint directory");
    if (created) await syncDirectory(dirname(path));
  }
  return path;
}
type FileIdentity = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;
type FileRead = {
  evidence: LocalRecoveryPayloadEvidence;
  content?: Buffer;
  identity?: FileIdentity;
};
const fileIdentity = (stat: BigIntStats): FileIdentity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
});
const sameFile = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
async function readEntry(
  path: string,
  checkpoint: LocalRecoveryCheckpoint,
  collect = false,
): Promise<FileRead> {
  try {
    const before = await fs.lstat(path, { bigint: true });
    if (before.isSymbolicLink()) return { evidence: "unsafe-path" };
    if (!before.isFile() || before.size !== BigInt(checkpoint.byteLength))
      return { evidence: "different-content" };
    const handle = await fs.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      )
        return { evidence: "different-content" };
      const buffer = Buffer.alloc(65536);
      // Only the bounded loader collects bytes, after checking its caller-supplied size limit.
      const content = collect ? Buffer.alloc(checkpoint.byteLength) : undefined;
      const hash = createHash("sha256");
      let total = 0;
      while (total <= checkpoint.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, checkpoint.byteLength + 1 - total),
          total,
        );
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
        if (content) buffer.copy(content, total, 0, Math.min(bytesRead, content.length - total));
        total += bytesRead;
      }
      const after = await fs.lstat(path, { bigint: true });
      const matching =
        after.isFile() &&
        after.dev === opened.dev &&
        after.ino === opened.ino &&
        after.size === opened.size &&
        after.mtimeNs === opened.mtimeNs &&
        after.ctimeNs === opened.ctimeNs &&
        total === checkpoint.byteLength &&
        hash.digest("hex") === checkpoint.sha256;
      return matching
        ? { evidence: "matching-content", content, identity: fileIdentity(after) }
        : { evidence: "different-content" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (code(error) === "ENOENT") return { evidence: "absent" };
    if (code(error) === "ELOOP") return { evidence: "unsafe-path" };
    return { evidence: "unreadable" };
  }
}
async function entry(
  path: string,
  checkpoint: LocalRecoveryCheckpoint,
): Promise<LocalRecoveryPayloadEvidence> {
  return (await readEntry(path, checkpoint)).evidence;
}
async function observe(root: string, checkpoint: LocalRecoveryCheckpoint) {
  try {
    const files = paths(await directory(root, false), checkpoint);
    return {
      published: await entry(files.published, checkpoint),
      temporary: await entry(files.temporary, checkpoint),
    };
  } catch (error) {
    const state: LocalRecoveryPayloadEvidence =
      error instanceof UnsafePayloadPath || code(error) === "ELOOP"
        ? "unsafe-path"
        : code(error) === "ENOENT"
          ? "absent"
          : "unreadable";
    return { published: state, temporary: state };
  }
}

/** Read-only inspection. Matching temporary data does not authorize publication or cleanup. */
export async function inspectRegisteredLocalRecoveryPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const checkpoint = await inspectLocalRecoveryCheckpoint(db, key);
  if (!checkpoint) throw new LocalRecoveryPayloadError("Trusted checkpoint is not registered");
  return { checkpoint, ...(await observe(root, checkpoint)) };
}
async function requireBinding(tx: Tx, expected: LocalRecoveryCheckpoint) {
  const { workspaceId, deviceId, epochId, checkpointId } = expected.identity;
  const current = await readLocalRecoveryCheckpoint(tx, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!current || JSON.stringify(current) !== JSON.stringify(expected))
    throw new LocalRecoveryPayloadError(
      "Trusted checkpoint binding changed before payload publication",
    );
}

async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  throw new LocalRecoveryPayloadError("Temporary checkpoint payload needs review");
}

/** Read a published checkpoint without installing rows, following links or consuming temporary data. */
export async function loadRegisteredLocalRecoveryPayload(options: {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  maxBytes: number;
  createValidationDatabase: () => Promise<DB>;
}): Promise<Readonly<{ snapshot: LocalRecoverySnapshot; checkpoint: LocalRecoveryCheckpoint }>> {
  const { root, db, maxBytes, createValidationDatabase } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new LocalRecoveryPayloadError("Payload read limit must be a positive safe integer");
  const expected = parseLocalRecoveryIdentity(options.expected);
  const { workspaceId, deviceId, epochId, checkpointId } = expected;
  const checkpoint = await inspectLocalRecoveryCheckpoint(db, {
    workspaceId,
    deviceId,
    epochId,
    checkpointId,
  });
  if (!checkpoint) throw new LocalRecoveryPayloadError("Trusted checkpoint is not registered");
  if (JSON.stringify(checkpoint.identity) !== JSON.stringify(expected))
    throw new LocalRecoveryPayloadError("Registered checkpoint identity mismatch");
  if (checkpoint.byteLength > maxBytes)
    throw new LocalRecoveryPayloadError("Registered payload exceeds read limit");
  const loaded = await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    const files = paths(await directory(root, false), checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new LocalRecoveryPayloadError(`Registered checkpoint payload is ${file.evidence}`);
    await requireNoTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new LocalRecoveryPayloadError("Registered checkpoint payload is not valid UTF-8 JSON", {
      cause,
    });
  }
  const snapshot = await validateStoredLocalRecoveryCheckpoint(
    db,
    createValidationDatabase,
    input,
    expected,
  );
  await withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    const files = paths(await directory(root, false), checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new LocalRecoveryPayloadError(
        "Registered checkpoint payload changed during validation",
      );
  });
  return Object.freeze({ snapshot, checkpoint });
}

/** Explicit publication of the original registered payload. Never retry callbacks or replace evidence. */
export async function saveRegisteredLocalRecoveryPayload(options: {
  root: string;
  db: DB;
  input: unknown;
  expected: LocalRecoveryIdentity;
  createValidationDatabase: () => Promise<DB>;
}) {
  const { root, db, input, expected, createValidationDatabase } = options;
  const validated = await validateStoredLocalRecoveryCheckpoint(
    db,
    createValidationDatabase,
    input,
    expected,
  );
  const { snapshot, checkpoint } = await describeLocalRecoverySnapshot(validated);
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  return withTx(db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_checkpoint SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    try {
      const dir = await directory(root, true);
      const files = paths(dir, checkpoint);
      const evidence = await observe(root, checkpoint);
      if (evidence.temporary !== "absent")
        throw new LocalRecoveryPayloadError("Temporary checkpoint payload needs review");
      if (evidence.published === "matching-content") {
        await syncDirectory(dir);
        await requireBinding(tx, checkpoint);
        return { path: files.published, checkpoint, changed: false };
      }
      if (evidence.published !== "absent")
        throw new LocalRecoveryPayloadError("Existing checkpoint payload needs review");
      const handle = await fs.open(
        files.temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if ((await entry(files.temporary, checkpoint)) !== "matching-content")
        throw new LocalRecoveryPayloadError(
          "Temporary checkpoint bytes differ from registered contents",
        );
      await fs.link(files.temporary, files.published);
      await fs.unlink(files.temporary);
      await syncDirectory(dir);
      if ((await entry(files.published, checkpoint)) !== "matching-content")
        throw new LocalRecoveryPayloadError(
          "Published checkpoint bytes differ from registered contents",
        );
      await requireBinding(tx, checkpoint);
      return { path: files.published, checkpoint, changed: true };
    } catch (cause) {
      throw new LocalRecoveryPayloadError(
        "Checkpoint payload publication failed; inspect retained evidence before retrying",
        { cause },
      );
    }
  });
}
