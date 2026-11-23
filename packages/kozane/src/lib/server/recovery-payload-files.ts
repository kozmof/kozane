/** Internal immutable file protocol for checkpoint payloads and asset manifests. */
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
class UnsafePayloadPath extends Error {}
export type RecoveryPayloadEvidence =
  | "absent"
  | "matching-content"
  | "different-content"
  | "unsafe-path"
  | "unreadable";
type Area =
  | "checkpoints"
  | "shared-history"
  | "asset-manifests"
  | "executions"
  | "actions"
  | "retained-history"
  | "retained-asset-manifests";
type RecoveryPayloadDescriptor = Readonly<{ sha256: string; byteLength: number }>;
const code = (error: unknown) => (error instanceof Error && "code" in error ? error.code : null);
export const paths = (directory: string, checkpoint: RecoveryPayloadDescriptor) => ({
  published: join(directory, `${checkpoint.sha256}.json`),
  temporary: join(directory, `.pending-${checkpoint.sha256}.json`),
});
export async function syncDirectory(path: string) {
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
export async function directory(root: string, create: boolean, area: Area = "checkpoints") {
  let path = await fs.realpath(root);
  for (const component of [".kozane", "recovery", area]) {
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
  evidence: RecoveryPayloadEvidence;
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
export const sameFile = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
export async function readEntry(
  path: string,
  checkpoint: RecoveryPayloadDescriptor,
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
export async function entry(
  path: string,
  checkpoint: RecoveryPayloadDescriptor,
): Promise<RecoveryPayloadEvidence> {
  return (await readEntry(path, checkpoint)).evidence;
}
export async function observe(
  root: string,
  checkpoint: RecoveryPayloadDescriptor,
  area: Area = "checkpoints",
) {
  try {
    const files = paths(await directory(root, false, area), checkpoint);
    return {
      published: await entry(files.published, checkpoint),
      temporary: await entry(files.temporary, checkpoint),
    };
  } catch (error) {
    const state: RecoveryPayloadEvidence =
      error instanceof UnsafePayloadPath || code(error) === "ELOOP"
        ? "unsafe-path"
        : code(error) === "ENOENT"
          ? "absent"
          : "unreadable";
    return { published: state, temporary: state };
  }
}

/** Caller owns the catalog writer transaction. Callback checks the exact retained expectation. */
export async function publishRecoveryPayload(
  root: string,
  area: Area,
  checkpoint: RecoveryPayloadDescriptor,
  bytes: Buffer,
  requireBinding: () => Promise<void>,
  PayloadError: new (message: string, options?: ErrorOptions) => Error,
) {
  await requireBinding();
  try {
    const dir = await directory(root, true, area);
    const files = paths(dir, checkpoint);
    const evidence = await observe(root, checkpoint, area);
    if (evidence.temporary !== "absent")
      throw new PayloadError("Temporary checkpoint payload needs review");
    if (evidence.published === "matching-content") {
      await syncDirectory(dir);
      await requireBinding();
      return { path: files.published, changed: false };
    }
    if (evidence.published !== "absent")
      throw new PayloadError("Existing checkpoint payload needs review");
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
      throw new PayloadError("Temporary checkpoint bytes differ from registered contents");
    await fs.link(files.temporary, files.published);
    await fs.unlink(files.temporary);
    await syncDirectory(dir);
    if ((await entry(files.published, checkpoint)) !== "matching-content")
      throw new PayloadError("Published checkpoint bytes differ from registered contents");
    await requireBinding();
    return { path: files.published, changed: true };
  } catch (cause) {
    throw new PayloadError(
      "Checkpoint payload publication failed; inspect retained evidence before retrying",
      { cause },
    );
  }
}
