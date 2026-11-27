/** Reserve and verify local image bytes before publishing a usable upload URL. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as crypto from "node:crypto";
import { dirname, join } from "node:path";
import { withTx, type DB } from "../../db/database.js";
import { localImageUploadTable } from "../../db/schema.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import { assertImageAssetIdentityInTx } from "../../db/api/asset-manifest.js";
import {
  imageUploadIdentity,
  readImageUploadReceipt,
  type ImageUploadRecord,
} from "../../db/api/image-upload-state.js";

export const imageDirectory = (root: string) => join(root, ".kozane", "assets", "images");

/** Check managed image directories without following component symlinks. Create only when requested. */
export async function imageAssetDirectory(root: string, create = true) {
  let path = await fs.realpath(root);
  for (const name of [".kozane", "assets", "images"]) {
    path = join(path, name);
    let created = false;
    if (create) {
      await fs
        .mkdir(path)
        .then(() => {
          created = true;
        })
        .catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
    }
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
      crypto.createHash("sha256").update(buffer.subarray(0, size)).digest("hex") !== sha256
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
  const filename = `${crypto.randomUUID()}.${extension}`;
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const record: ImageUploadRecord = {
    filename,
    sha256,
    byteLength: bytes.byteLength,
    state: "pending" as const,
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    installedAt: null,
    completedAt: null,
    error: null,
    abandonedAt: null,
    abandonReason: null,
  };
  // The pin is committed before any directory or file is created.
  await withTx(db, async (tx) => {
    await lockImageAssetWork(tx);
    await assertImageAssetIdentityInTx(tx, {
      version: 1,
      entries: [
        { name: `.kozane/assets/images/${filename}`, byteLength: record.byteLength, sha256 },
      ],
    });
    await tx.insert(localImageUploadTable).values(record);
    await readImageUploadReceipt(tx, record);
  });
  let attempted = false;
  let diskComplete = false;
  try {
    await withTx(db, async (tx) => {
      await lockImageAssetWork(tx);
      await readImageUploadReceipt(tx, record);
      attempted = true;
      const dir = await imageAssetDirectory(root);
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
      const expected: ImageUploadRecord = {
        ...record,
        state: "installed",
        installedAt: new Date(),
      };
      const [installed] = await tx
        .update(localImageUploadTable)
        .set({ state: expected.state, installedAt: expected.installedAt })
        .where(imageUploadIdentity(record))
        .returning({ filename: localImageUploadTable.filename });
      if (!installed) throw new Error("Image upload reservation changed or is missing");
      await verifyImageUploadFile(target, record.byteLength, sha256);
      if ((await imageAssetDirectory(root, false)) !== dir)
        throw new Error("Image directory changed during installation");
      const temporaryExists = await fs.lstat(temporary).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (temporaryExists)
        throw new Error("Image upload temporary file remains after installation");
      await readImageUploadReceipt(tx, expected);
    });
  } catch (cause) {
    if (attempted && !diskComplete) {
      try {
        const message = String(cause);
        await withTx(db, async (tx) => {
          await lockImageAssetWork(tx);
          const [recorded] = await tx
            .update(localImageUploadTable)
            .set({ error: message })
            .where(imageUploadIdentity(record))
            .returning({ filename: localImageUploadTable.filename });
          if (!recorded) throw new Error("Image upload error could not be retained", { cause });
          await readImageUploadReceipt(tx, { ...record, error: message });
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
