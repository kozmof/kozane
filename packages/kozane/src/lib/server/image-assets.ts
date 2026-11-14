import { composeWrite } from "../../db/database.js";
import { validPng, validJpeg } from "./raster-validation.js";
import { activeServerProcess } from "./runtime-state.js";
import { mkdir, readFile, writeFile, readdir, stat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { imagePath, IMAGE_MAX_BYTES } from "@kozane/core";
import type { DB } from "../../db/tx.js";
import { cardTable } from "../../db/schema.js";

export function imageDirectory(root: string): string {
  return join(root, ".kozane", "assets", "images");
}
export class ImageValidationError extends Error {}

export async function validateImage(name: string, bytes: Uint8Array): Promise<string> {
  const extension = name.split(".").pop()?.toLowerCase();
  if (!extension || !["jpg", "jpeg", "png", "svg"].includes(extension))
    throw new ImageValidationError("Choose JPEG, PNG, or SVG");
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES)
    throw new ImageValidationError("Image must be between 1 byte and 10 MiB");
  let valid = false;
  try {
    valid =
      extension === "png"
        ? await validPng(bytes)
        : extension === "svg"
          ? validSvg(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
          : validJpeg(bytes);
  } catch {
    valid = false;
  }
  if (!valid) throw new ImageValidationError("File content does not match its image extension");
  return extension;
}
function validSvg(source: string): boolean {
  // Reject active content and external resources. SVGs are served in a sandbox as well.
  const clean = source
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (
    !/^<svg(?:\s|\/?>)/i.test(clean) ||
    /<!|<\s*(?:script|foreignObject)\b|\bon\w+\s*=/i.test(clean)
  )
    return false;
  if (clean.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);/gi, "").includes("&"))
    return false;
  let decoded: string;
  try {
    decoded = clean.replace(/&([^;]*);/g, (_, entity: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (named[entity]) return named[entity];
      if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity)) throw new Error("Invalid XML entity");
      const value =
        entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!value || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
        throw new Error("Invalid XML character");
      return String.fromCodePoint(value);
    });
  } catch {
    return false;
  }
  // Inspect decoded values so character references cannot hide resource URLs.
  const references = decoded
    .replace(/(?:[\w.-]+:)?(?:href|src)\s*=\s*(["'])\s*#[A-Za-z_][\w:.-]*\s*\1/gi, "")
    .replace(/url\(\s*(["']?)#[A-Za-z_][\w:.-]*\1\s*\)/gi, "");
  if (/(?:href|src)\s*=|url\s*\(|@import|\\/i.test(references)) return false;
  const stack: string[] = [];
  let offset = 0;
  let roots = 0;
  const tags = /<([^<>]+)>/g;
  for (const match of clean.matchAll(tags)) {
    if (clean.slice(offset, match.index).includes("<")) return false;
    const token = match[1];
    const closing = /^\/([A-Za-z][\w:.-]*)\s*$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) return false;
    } else {
      const opening = /^([A-Za-z][\w:.-]*)([\s\S]*?)(\/?)$/.exec(token);
      if (!opening) return false;
      const attributeNames = new Set<string>();
      for (const attribute of opening[2].matchAll(
        /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:"[^"<>]*"|'[^'<>]*')/g,
      )) {
        if (attributeNames.has(attribute[1])) return false;
        attributeNames.add(attribute[1]);
      }
      // Attributes must be quoted. Reject unmatched or unquoted fragments.
      if (opening[2].replace(/\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*')/g, "").trim())
        return false;
      if (!stack.length && ++roots > 1) return false;
      if (!opening[3]) stack.push(opening[1]);
    }
    offset = match.index! + match[0].length;
  }
  return roots === 1 && stack.length === 0 && clean.slice(offset).trim() === "";
}
export async function storeImage(root: string, name: string, bytes: Uint8Array): Promise<string> {
  const extension = await validateImage(name, bytes);
  const filename = randomUUID() + "." + extension;
  await mkdir(imageDirectory(root), { recursive: true });
  await writeFile(join(imageDirectory(root), filename), bytes, { flag: "wx" });
  return "/api/images/" + filename;
}
/** Keep fresh uploads for a day so concurrent card creation cannot lose its image. */
export async function collectUnusedImages(root: string, db: DB, now = Date.now()): Promise<void> {
  if (process.env.KOZANE_MEMORY_MODE === "1" || activeServerProcess(root)?.memory) return;
  const referenced = new Set(
    (await db.select({ content: cardTable.content }).from(cardTable)).map((row) =>
      imagePath(row.content),
    ),
  );
  let names: string[];
  try {
    names = await readdir(imageDirectory(root));
  } catch {
    return;
  }
  for (const name of names) {
    const path = "/api/images/" + name;
    if (!imagePath("kozane-image:" + path) || referenced.has(path)) continue;
    const filename = join(imageDirectory(root), name);
    try {
      if ((await stat(filename)).mtimeMs < now - 86400000) {
        const archive = join(imageDirectory(root), ".retained");
        await mkdir(archive, { recursive: true });
        await rename(filename, join(archive, name));
      }
    } catch {
      /* Another collector may have removed it. */
    }
  }
}
export async function readImage(root: string, name: string): Promise<Uint8Array> {
  if (!imagePath("kozane-image:/api/images/" + name)) throw new Error("Invalid image name");
  try {
    return await readFile(join(imageDirectory(root), name));
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
    return readFile(join(imageDirectory(root), ".retained", name));
  }
}

const maintenance = new Map<string, { at: number; running: boolean }>();
/** Opportunistic maintenance must never change the outcome of a committed write. */
export async function maintainImageAssets(root: string, db: DB, now = Date.now()): Promise<void> {
  const previous = maintenance.get(root);
  if (previous && (previous.running || now - previous.at < 60 * 60 * 1000)) return;
  maintenance.set(root, { at: now, running: true });
  try {
    await collectUnusedImages(root, db, now);
  } catch {
    /* Retry on a later maintenance opportunity. */
  } finally {
    maintenance.set(root, { at: now, running: false });
  }
}

/** Remove assets belonging to deleted cards only after the database deletion commits. */
export async function withImageDeletion<T>(
  root: string | null,
  db: DB,
  removeCards: () => Promise<T>,
): Promise<T> {
  if (!root || process.env.KOZANE_MEMORY_MODE === "1" || activeServerProcess(root)?.memory)
    return removeCards();
  const before = await db.select({ id: cardTable.id, content: cardTable.content }).from(cardTable);
  const result = await removeCards();
  // Cleanup is serialized with card writers. A remaining reference always keeps its image.
  try {
    await composeWrite(db, async (tx) => {
      const remaining = await tx
        .select({ id: cardTable.id, content: cardTable.content })
        .from(cardTable);
      const ids = new Set(remaining.map((row) => row.id));
      const references = new Set(remaining.map((row) => imagePath(row.content)));
      const deleted = new Set(
        before.filter((row) => !ids.has(row.id)).map((row) => imagePath(row.content)),
      );
      for (const path of deleted) {
        if (!path || references.has(path)) continue;
        const name = path.split("/").pop()!;
        await rm(join(imageDirectory(root), name), { force: true });
        await rm(join(imageDirectory(root), ".retained", name), { force: true });
      }
    });
  } catch (cause) {
    console.warn("Image cleanup after card deletion failed:", cause);
  }
  return result;
}
