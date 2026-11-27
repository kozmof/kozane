/** Local manifest ownership and protection. Host verification precedes trusted finalization. */
import { and, eq, inArray } from "drizzle-orm";
import { mergeAssetManifests, parseAssetManifest, type AssetManifest } from "@kozane/core";
import { withTx, withReadTx, type DB, type Tx, type ReadTx } from "../database.js";
import { localAssetManifestTable, localImageUploadTable } from "../schema.js";
import { lockImageAssetWork } from "./image-upload.js";

type Row = typeof localAssetManifestTable.$inferSelect;
export type AssetManifestOwner = Readonly<{ kind: Row["ownerKind"]; id: string }>;
const kinds = ["baseline", "effect-set", "pending-work", "transfer", "recovery"];
function owner(input: AssetManifestOwner): AssetManifestOwner {
  if (
    !kinds.includes(input.kind) ||
    typeof input.id !== "string" ||
    !input.id.trim() ||
    input.id.length > 1000 ||
    input.id.includes("\0") ||
    !input.id.isWellFormed()
  )
    throw new Error("Invalid asset manifest owner");
  return Object.freeze({ kind: input.kind, id: input.id });
}
function where(input: AssetManifestOwner) {
  return and(
    eq(localAssetManifestTable.ownerKind, input.kind),
    eq(localAssetManifestTable.ownerId, input.id),
  );
}
export async function readAssetManifest(db: DB | Tx | ReadTx, input: AssetManifestOwner) {
  const key = owner(input);
  const row = await db.select().from(localAssetManifestTable).where(where(key)).get();
  if (!row) throw new Error("Asset manifest owner not found");
  return { record: row, manifest: parseAssetManifest(JSON.parse(row.manifest)) };
}

/** Hold the asset writer lock before checking and publishing a new identity. */
export async function assertImageAssetIdentityInTx(tx: Tx, input: unknown): Promise<AssetManifest> {
  const manifest = parseAssetManifest(input);
  const uploads = await tx
    .select({
      filename: localImageUploadTable.filename,
      byteLength: localImageUploadTable.byteLength,
      sha256: localImageUploadTable.sha256,
    })
    .from(localImageUploadTable);
  const retained = await tx
    .select({ manifest: localAssetManifestTable.manifest })
    .from(localAssetManifestTable);
  // Released owners and completed/abandoned uploads still record immutable name identity.
  mergeAssetManifests([
    manifest,
    {
      version: 1,
      entries: uploads.map((row) => ({
        name: `.kozane/assets/images/${row.filename}`,
        byteLength: row.byteLength,
        sha256: row.sha256,
      })),
    },
    ...retained.map((row) => JSON.parse(row.manifest)),
  ]);
  return manifest;
}

export async function reserveAssetManifestInTx(tx: Tx, input: AssetManifestOwner, value: unknown) {
  const key = owner(input);
  const manifest = parseAssetManifest(value);
  await lockImageAssetWork(tx);
  await assertImageAssetIdentityInTx(tx, manifest);
  const existing = await tx.select().from(localAssetManifestTable).where(where(key)).get();
  if (existing) {
    if (existing.state === "released") throw new Error("Released manifest owners cannot be reused");
    if (
      JSON.stringify(parseAssetManifest(JSON.parse(existing.manifest))) !== JSON.stringify(manifest)
    )
      throw new Error("Owner already has a different asset manifest");
    return { record: existing, manifest, changed: false };
  }
  const [record] = await tx
    .insert(localAssetManifestTable)
    .values({
      ownerKind: key.kind,
      ownerId: key.id,
      manifest: JSON.stringify(manifest),
      state: "pending",
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    })
    .returning();
  return { record, manifest, changed: true };
}

export function reserveAssetManifest(db: DB, input: AssetManifestOwner, value: unknown) {
  const key = owner(input);
  const manifest = parseAssetManifest(value);
  return withTx(db, (tx) => reserveAssetManifestInTx(tx, key, manifest));
}

function safeDates(record: Row) {
  if (
    ![record.createdAt, record.verifiedAt, record.releasedAt].every(
      (date) => date === null || Number.isSafeInteger(date.getTime()),
    )
  )
    throw new Error("Asset manifest timestamps cannot be represented safely");
}

/** Trusted host finalization. Verify protected local bytes in this transaction before calling. */
export async function confirmVerifiedAssetManifestInTx(
  tx: Tx,
  input: AssetManifestOwner,
  expected: string,
) {
  const key = owner(input);
  await lockImageAssetWork(tx);
  const current = await readAssetManifest(tx, key);
  safeDates(current.record);
  if (current.record.manifest !== expected)
    throw new Error("Asset manifest changed during verification");
  if (current.record.state === "released") throw new Error("Asset manifest was released");
  if (current.record.state === "retained") return { ...current, changed: false };
  const [record] = await tx
    .update(localAssetManifestTable)
    .set({ state: "retained", verifiedAt: new Date() })
    .where(
      and(
        where(key),
        eq(localAssetManifestTable.state, "pending"),
        eq(localAssetManifestTable.manifest, expected),
        eq(localAssetManifestTable.createdAt, current.record.createdAt),
      ),
    )
    .returning();
  if (!record) throw new Error("Asset manifest changed or is missing");
  return { record, manifest: current.manifest, changed: true };
}

export async function releaseAssetManifestInTx(
  tx: Tx,
  input: AssetManifestOwner,
  inputReason: string,
) {
  const key = owner(input);
  const reason = inputReason.trim();
  if (!reason || reason.length > 1000 || reason.includes("\0"))
    throw new Error("Release reason must contain 1–1000 characters without NUL");
  await lockImageAssetWork(tx);
  const current = await readAssetManifest(tx, key);
  safeDates(current.record);
  if (current.record.state === "released") {
    if (current.record.releaseReason !== reason)
      throw new Error("Asset manifest was released with another reason");
    return { ...current, changed: false };
  }
  const [record] = await tx
    .update(localAssetManifestTable)
    .set({ state: "released", releasedAt: new Date(), releaseReason: reason })
    .where(
      and(
        where(key),
        eq(localAssetManifestTable.state, current.record.state),
        eq(localAssetManifestTable.manifest, current.record.manifest),
        eq(localAssetManifestTable.createdAt, current.record.createdAt),
      ),
    )
    .returning();
  if (!record) throw new Error("Asset manifest changed or is missing");
  return { record, manifest: current.manifest, changed: true };
}

export function releaseAssetManifest(db: DB, input: AssetManifestOwner, inputReason: string) {
  const key = owner(input);
  const reason = inputReason.trim();
  return withTx(db, (tx) => releaseAssetManifestInTx(tx, key, reason));
}

/** Read under the asset writer lock before cleanup. Corrupt active records fail closed. */
export async function retainedImageNames(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({ manifest: localAssetManifestTable.manifest })
    .from(localAssetManifestTable)
    .where(inArray(localAssetManifestTable.state, ["pending", "retained"]));
  const names = new Set<string>();
  for (const row of rows)
    for (const entry of parseAssetManifest(JSON.parse(row.manifest)).entries)
      names.add(entry.name.slice(".kozane/assets/images/".length));
  return names;
}

export function inspectAssetManifest(db: DB, input: AssetManifestOwner) {
  const key = owner(input);
  return withReadTx(db, (tx) => readAssetManifest(tx, key));
}
