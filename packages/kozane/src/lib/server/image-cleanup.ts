/** Filesystem cleanup helpers. The caller owns the image database writer lock. */
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { imagePath } from "@kozane/core";
import { imageAssetDirectory, syncImageDirectory } from "./image-upload.js";

const code = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : null;
async function childDirectory(
  images: string,
  name: ".retained" | ".pending-delete",
  create = false,
) {
  const path = join(images, name);
  let created = false;
  if (create) {
    try {
      await fs.mkdir(path);
      created = true;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
  }
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Image cleanup directory is unsafe");
    if (created) await syncImageDirectory(images);
    return path;
  } catch (error) {
    if (!create && code(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function imageCleanupDirectories(root: string) {
  const images = await imageAssetDirectory(root, false);
  const retained = await childDirectory(images, ".retained");
  const pending = await childDirectory(images, ".pending-delete");
  return { images, retained, pending };
}

function validName(name: string) {
  if (!imagePath("kozane-image:/api/images/" + name)) throw new Error("Invalid image cleanup name");
}
function sameFile(actual: BigIntStats, original: BigIntStats) {
  return (
    actual.isFile() &&
    original.isFile() &&
    actual.dev === original.dev &&
    actual.ino === original.ino &&
    actual.size === original.size &&
    actual.mtimeNs === original.mtimeNs
  );
}

/** Keep the request inode alive until acknowledgment, including after external unlinking. */
export async function openImageDeletionRequest(pending: string, name: string) {
  validName(name);
  const path = join(pending, name);
  const entry = await fs.lstat(path, { bigint: true }).catch((error) => {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.size !== 0n) throw new Error("Image deletion request is unsafe");
  const handle = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const identity = await handle.stat({ bigint: true });
    if (!sameFile(entry, identity)) throw new Error("Image deletion request changed");
    return { handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Publish without overwriting. A same-inode archive resumes an interrupted link and unlink. */
export async function archiveUnusedImage(root: string, name: string, cutoff: number) {
  validName(name);
  const initial = await imageCleanupDirectories(root);
  const source = join(initial.images, name);
  const entry = await fs.lstat(source, { bigint: true });
  if (!entry.isFile() || entry.mtimeMs >= BigInt(Math.trunc(cutoff))) return false;
  const handle = await fs.open(
    source,
    // Windows FlushFileBuffers needs write access. This handle never writes file contents.
    (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const original = await handle.stat({ bigint: true });
    if (!sameFile(entry, original) || !sameFile(await fs.lstat(source, { bigint: true }), original))
      throw new Error("Image changed before archiving");
    await handle.sync();
    const retained = (await childDirectory(initial.images, ".retained", true))!;
    const target = join(retained, name);
    try {
      await fs.link(source, target);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      if (!sameFile(await fs.lstat(target, { bigint: true }), original)) return false;
    }
    // The archive entry must survive a crash before the live entry is removed.
    await handle.sync();
    await syncImageDirectory(retained);
    const current = await imageCleanupDirectories(root);
    if (
      current.images !== initial.images ||
      current.retained !== retained ||
      !sameFile(await fs.lstat(source, { bigint: true }), original) ||
      !sameFile(await fs.lstat(target, { bigint: true }), original)
    )
      throw new Error("Image changed during archiving");
    await fs.unlink(source);
    await syncImageDirectory(initial.images);
    return true;
  } finally {
    await handle.close();
  }
}

/** Persist the request before its enclosing card transaction may commit. */
export async function queueImageDeletion(root: string, name: string) {
  validName(name);
  await imageAssetDirectory(root);
  const current = await imageCleanupDirectories(root);
  const pending = (await childDirectory(current.images, ".pending-delete", true))!;
  const requestPath = join(pending, name);
  const existing = await fs.lstat(requestPath, { bigint: true }).catch((error) => {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.size !== 0n))
    throw new Error("Image deletion request is unsafe");
  const handle = await fs.open(
    requestPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const entry = await fs.lstat(requestPath, { bigint: true });
    if (!stat.isFile() || stat.size !== 0n || !sameFile(entry, stat))
      throw new Error("Image deletion request is unsafe");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncImageDirectory(pending);
}
