/** Immutable image publication for an already committed destination manifest reservation. */
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parseAssetManifest, type AssetManifestEntry } from "@kozane/core";
import { imageAssetDirectory } from "./image-upload.js";
import { readEntry, entry, syncDirectory } from "./recovery-payload-files.js";
const prefix = ".kozane/assets/images/";
const filename = (value: AssetManifestEntry) => value.name.slice(prefix.length);
const code = (error: unknown) => (error instanceof Error && "code" in error ? error.code : null);
export const recoveryImageTemporaryName = (checkpointHash: string, imageFilename: string) =>
  `.recovery-${checkpointHash}-${imageFilename}`;
async function exists(path: string) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}
async function sourceBytes(root: string, value: AssetManifestEntry) {
  const dir = await imageAssetDirectory(root, false),
    name = filename(value);
  let observed = await readEntry(join(dir, name), value, true);
  if (observed.evidence === "absent") {
    const archive = join(dir, ".retained"),
      stat = await fs.lstat(archive);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Source image archive is unsafe");
    observed = await readEntry(join(archive, name), value, true);
  }
  if (observed.evidence !== "matching-content" || !observed.content)
    throw new Error(`Required source image is ${observed.evidence}: ${value.name}`);
  return observed.content;
}
/** Caller holds the destination image writer lock and rechecks the exact pending/retained owner. */
export async function publishRecoveryImage(
  sourceRoot: string,
  destinationRoot: string,
  checkpointHash: string,
  input: AssetManifestEntry,
  requireReservation: () => Promise<void>,
) {
  const value = parseAssetManifest({ version: 1, entries: [input] }).entries[0];
  if (!/^[a-f0-9]{64}$/.test(checkpointHash))
    throw new Error("Invalid recovery image checkpoint hash");
  await requireReservation();
  const dir = await imageAssetDirectory(destinationRoot),
    name = filename(value),
    target = join(dir, name),
    temporary = join(dir, recoveryImageTemporaryName(checkpointHash, name));
  if ((await exists(temporary)) || (await exists(join(dir, `.upload-${name}`))))
    throw new Error("Temporary destination image needs review");
  const archive = join(dir, ".retained");
  let archived = "absent";
  if (await exists(archive)) {
    const stat = await fs.lstat(archive);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Destination image archive is unsafe");
    archived = await entry(join(archive, name), value);
    if (archived !== "absent" && archived !== "matching-content")
      throw new Error(`Existing destination archive image is ${archived}: ${value.name}`);
  }
  const current = await entry(target, value);
  if (current === "matching-content") {
    await syncDirectory(dir);
    await requireReservation();
    return Object.freeze({ changed: false, path: target });
  }
  if (current !== "absent")
    throw new Error(`Existing destination image is ${current}: ${value.name}`);
  if (archived === "matching-content") {
    await syncDirectory(archive);
    await requireReservation();
    return Object.freeze({ changed: false, path: join(archive, name) });
  }
  const bytes = await sourceBytes(sourceRoot, value);
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
  if ((await entry(temporary, value)) !== "matching-content")
    throw new Error("Temporary destination image bytes changed");
  await requireReservation();
  await fs.link(temporary, target);
  await fs.unlink(temporary);
  await syncDirectory(dir);
  if ((await entry(target, value)) !== "matching-content")
    throw new Error("Published destination image bytes changed");
  await requireReservation();
  return Object.freeze({ changed: true, path: target });
}
