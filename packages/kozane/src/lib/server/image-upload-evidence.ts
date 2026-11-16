/** Read-only observations of intended upload bytes. No installation or cleanup runs here. */
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_MAX_BYTES, imagePath } from "@kozane/core";
import {
  imageDirectory,
  ImageUploadVerificationError,
  verifyImageUploadFile,
} from "./image-upload.js";

export type ImageUploadEvidence =
  | "matching-content"
  | "different-content"
  | "absent"
  | "unsafe-path"
  | "unreadable"
  | "invalid-record";
type Intent = { filename: string; byteLength: number; sha256: string };
export function validImageUploadFilename(filename: unknown): filename is string {
  return (
    typeof filename === "string" &&
    filename.trim() === filename &&
    imagePath("kozane-image:/api/images/" + filename) !== null
  );
}
const code = (error: unknown) => (error instanceof Error && "code" in error ? error.code : null);
async function entry(path: string, record: Intent): Promise<ImageUploadEvidence> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) return "unsafe-path";
    if (!stat.isFile() || stat.size !== BigInt(record.byteLength)) return "different-content";
    await verifyImageUploadFile(path, record.byteLength, record.sha256);
    return "matching-content";
  } catch (error) {
    if (code(error) === "ENOENT") return "absent";
    if (code(error) === "ELOOP") return "unsafe-path";
    return error instanceof ImageUploadVerificationError ? "different-content" : "unreadable";
  }
}

export async function inspectImageUpload(root: string, record: Intent) {
  const both = (state: ImageUploadEvidence) => ({ published: state, temporary: state });
  if (
    !validImageUploadFilename(record.filename) ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 1 ||
    record.byteLength > IMAGE_MAX_BYTES ||
    typeof record.sha256 !== "string" ||
    record.sha256.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  )
    return both("invalid-record");
  let base: string;
  try {
    base = await realpath(root);
  } catch {
    return both("unreadable");
  }
  try {
    let path = base;
    for (const component of [".kozane", "assets", "images"]) {
      path = join(path, component);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return both("unsafe-path");
    }
  } catch (error) {
    return both(code(error) === "ENOENT" ? "absent" : "unreadable");
  }
  const directory = imageDirectory(base);
  return {
    published: await entry(join(directory, record.filename), record),
    temporary: await entry(join(directory, `.upload-${record.filename}`), record),
  };
}

/** A retained logical image may already live in the readable archive. Never hide corrupt live bytes. */
export async function inspectRetainedImage(
  root: string,
  record: Intent,
): Promise<ImageUploadEvidence> {
  const evidence = await inspectImageUpload(root, record);
  if (evidence.published !== "absent") return evidence.published;
  try {
    const directory = imageDirectory(await realpath(root));
    const archive = join(directory, ".retained");
    const stat = await lstat(archive);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe-path";
    return entry(join(archive, record.filename), record);
  } catch (error) {
    return code(error) === "ENOENT" ? "absent" : "unreadable";
  }
}
