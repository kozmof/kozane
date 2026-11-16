/** Reserve and verify local image bytes before publishing a usable upload URL. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { withTx, type DB } from "../../db/database.js";
import { localImageUploadTable } from "../../db/schema.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";

export const imageDirectory = (root: string) => join(root, ".kozane", "assets", "images");

async function directory(root: string) {
  let path = await fs.realpath(root);
  for (const name of [".kozane", "assets", "images"]) {
    path = join(path, name);
    let created = true;
    await fs.mkdir(path).catch((error) => {
      if (error.code !== "EEXIST") throw error;
      created = false;
    });
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Image directory is unsafe");
    if (created) await syncDirectory(dirname(path));
  }
  return path;
}

async function syncDirectory(path: string) {
  // Windows does not expose directory fsync through Node. The file itself is always synced.
  if (process.platform === "win32") return;
  const handle = await fs.open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ImageUploadVerificationError extends Error {
  override readonly name = "ImageUploadVerificationError";
}

export async function verifyImageUploadFile(path: string, length: number, sha256: string) {
  const handle = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(length))
      throw new ImageUploadVerificationError("Installed image length differs from intent");
    const buffer = Buffer.alloc(length + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const current = await fs.lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      size !== length ||
      createHash("sha256").update(buffer.subarray(0, size)).digest("hex") !== sha256
    )
      throw new ImageUploadVerificationError("Installed image bytes differ from intent");
  } finally {
    await handle.close();
  }
}

/** Caller owns validated bytes. Never repeat filesystem callbacks after an interrupted install. */
export async function installImageUpload(
  root: string,
  db: DB,
  extension: string,
  bytes: Uint8Array,
) {
  const filename = `${randomUUID()}.${extension}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const record = {
    filename,
    sha256,
    byteLength: bytes.byteLength,
    state: "pending" as const,
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
  };
  // The pin is committed before any directory or file is created.
  await withTx(db, async (tx) => {
    await tx.insert(localImageUploadTable).values(record);
  });
  let attempted = false;
  let diskComplete = false;
  try {
    await withTx(db, async (tx) => {
      await lockImageAssetWork(tx);
      const current = await tx
        .select()
        .from(localImageUploadTable)
        .where(eq(localImageUploadTable.filename, filename))
        .get();
      if (
        !current ||
        current.state !== "pending" ||
        current.error !== null ||
        current.sha256 !== sha256 ||
        current.byteLength !== bytes.byteLength ||
        current.createdAt.getTime() !== record.createdAt.getTime()
      )
        throw new Error("Image upload reservation changed");
      attempted = true;
      const dir = await directory(root);
      const temporary = join(dir, `.upload-${filename}`);
      const target = join(dir, filename);
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Linking publishes the synced bytes atomically and refuses an existing destination.
      await fs.link(temporary, target);
      await fs.unlink(temporary);
      await syncDirectory(dir);
      await verifyImageUploadFile(target, bytes.byteLength, sha256);
      diskComplete = true;
      const [installed] = await tx
        .update(localImageUploadTable)
        .set({ state: "installed", installedAt: new Date() })
        .where(
          and(
            eq(localImageUploadTable.filename, filename),
            eq(localImageUploadTable.state, "pending"),
            eq(localImageUploadTable.sha256, sha256),
            eq(localImageUploadTable.byteLength, bytes.byteLength),
            eq(localImageUploadTable.createdAt, record.createdAt),
            isNull(localImageUploadTable.error),
          ),
        )
        .returning();
      if (!installed) throw new Error("Image upload reservation changed or is missing");
    });
  } catch (cause) {
    if (attempted && !diskComplete) {
      try {
        await withTx(db, async (tx) => {
          const [recorded] = await tx
            .update(localImageUploadTable)
            .set({ error: String(cause) })
            .where(
              and(
                eq(localImageUploadTable.filename, filename),
                eq(localImageUploadTable.state, "pending"),
                eq(localImageUploadTable.sha256, sha256),
                eq(localImageUploadTable.byteLength, bytes.byteLength),
                eq(localImageUploadTable.createdAt, record.createdAt),
              ),
            )
            .returning();
          if (!recorded) throw new Error("Image upload error could not be retained", { cause });
        });
      } catch (recordError) {
        throw new AggregateError(
          [cause, recordError],
          `Image upload ${filename} and error recording failed`,
          { cause: recordError },
        );
      }
    }
    throw new Error(`Image upload ${filename} needs review. Disk work was not retried`, { cause });
  }
  return "/api/images/" + filename;
}
