/** Explicitly reconcile local upload metadata. Filesystem work is never repeated. */
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { withReadTx, withTx, type DB, type ReadTx, type Tx } from "../../db/database.js";
import { cardTable, localImageUploadTable } from "../../db/schema.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import { inspectImageUpload, validImageUploadFilename } from "./image-upload-evidence.js";

type Upload = typeof localImageUploadTable.$inferSelect;
function filename(input: string) {
  if (typeof input !== "string" || !validImageUploadFilename(input))
    throw new Error("Use the full image upload filename");
}
async function get(db: ReadTx | Tx, name: string) {
  const row = await db
    .select()
    .from(localImageUploadTable)
    .where(eq(localImageUploadTable.filename, name))
    .get();
  if (!row) throw new Error("Image upload record not found");
  return row;
}
async function referenced(db: ReadTx | Tx, name: string) {
  return !!(await db
    .select({ id: cardTable.id })
    .from(cardTable)
    .where(eq(cardTable.content, "kozane-image:/api/images/" + name))
    .limit(1)
    .get());
}
function identity(row: Upload) {
  return and(
    eq(localImageUploadTable.filename, row.filename),
    eq(localImageUploadTable.state, row.state),
    eq(localImageUploadTable.sha256, row.sha256),
    eq(localImageUploadTable.byteLength, row.byteLength),
    eq(localImageUploadTable.createdAt, row.createdAt),
    row.installedAt === null
      ? isNull(localImageUploadTable.installedAt)
      : eq(localImageUploadTable.installedAt, row.installedAt),
    row.completedAt === null
      ? isNull(localImageUploadTable.completedAt)
      : eq(localImageUploadTable.completedAt, row.completedAt),
    row.error === null
      ? isNull(localImageUploadTable.error)
      : eq(localImageUploadTable.error, row.error),
    row.abandonedAt === null
      ? isNull(localImageUploadTable.abandonedAt)
      : eq(localImageUploadTable.abandonedAt, row.abandonedAt),
    row.abandonReason === null
      ? isNull(localImageUploadTable.abandonReason)
      : eq(localImageUploadTable.abandonReason, row.abandonReason),
  );
}
/** Read after triggers with the expected predicate before decoding any changed timestamps. */
async function receipt(tx: Tx, expected: Upload) {
  const upload = await tx.select().from(localImageUploadTable).where(identity(expected)).get();
  if (!upload) throw new Error("Image upload publication changed or is missing");
  return upload;
}
function safeDates(row: Upload) {
  return [row.createdAt, row.installedAt, row.completedAt, row.abandonedAt].every(
    (date) => date === null || Number.isSafeInteger(date.getTime()),
  );
}
async function inspect(db: ReadTx | Tx, root: string, name: string) {
  const upload = await get(db, name);
  if (upload.state === "abandoned") throw new Error("This image upload was abandoned");
  const linked = await referenced(db, name);
  if (upload.state === "completed")
    return { upload, linked, status: "already-completed" as const, reason: null, evidence: null };
  const evidence = await inspectImageUpload(root, upload);
  const blocked = (reason: string) => ({
    upload,
    linked,
    status: "blocked" as const,
    reason,
    evidence,
  });
  if (!safeDates(upload)) return blocked("Upload timestamps cannot be represented safely");
  if (upload.error !== null)
    return blocked(
      "A filesystem error was recorded. Review and repair disk state, then abandon tracking",
    );
  if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
    return blocked(
      `Published file is ${evidence.published}; temporary file is ${evidence.temporary}`,
    );
  return {
    upload,
    linked,
    status:
      upload.state === "installed" && !linked
        ? ("already-installed" as const)
        : ("confirmable" as const),
    reason: null,
    evidence,
  };
}

export async function recoverImageUpload(db: DB, root: string, name: string, apply = false) {
  filename(name);
  if (!apply) return withReadTx(db, (tx) => inspect(tx, root, name));
  return withTx(db, async (tx) => {
    await lockImageAssetWork(tx);
    const current = await inspect(tx, root, name);
    if (current.status === "blocked")
      throw new Error(`Image upload cannot be recovered: ${current.reason}`);
    if (current.status !== "confirmable") return current;
    const now = new Date();
    const expected: Upload = {
      ...current.upload,
      state: current.linked ? "completed" : "installed",
      installedAt: current.upload.installedAt ?? now,
      completedAt: current.linked ? now : current.upload.completedAt,
    };
    const [changed] = await tx
      .update(localImageUploadTable)
      .set({
        state: expected.state,
        installedAt: expected.installedAt,
        completedAt: expected.completedAt,
      })
      .where(identity(current.upload))
      .returning({ filename: localImageUploadTable.filename });
    if (!changed) throw new Error("Image upload intent changed or is missing");
    const evidence = await inspectImageUpload(root, expected);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new Error(
        `Image upload bytes changed during recovery: published ${evidence.published}, temporary ${evidence.temporary}`,
      );
    if ((await referenced(tx, name)) !== current.linked)
      throw new Error("Image upload references changed during recovery");
    const upload = await receipt(tx, expected);
    return { ...current, upload, evidence, status: "confirmed" as const };
  });
}

export async function abandonImageUpload(db: DB, name: string, inputReason: string, apply = false) {
  filename(name);
  if (typeof inputReason !== "string") throw new Error("Abandonment reason is required");
  const reason = inputReason.trim();
  if (!reason || reason.length > 1000 || reason.includes("\0"))
    throw new Error("Abandonment reason must contain 1–1000 characters without NUL");
  const inspect = async (tx: ReadTx | Tx) => {
    const upload = await get(tx, name);
    if (!safeDates(upload)) throw new Error("Upload timestamps cannot be represented safely");
    if (upload.state === "completed")
      throw new Error("Completed image uploads cannot be abandoned");
    if (upload.state === "abandoned" && upload.abandonReason !== reason)
      throw new Error("Upload was already abandoned with another reason");
    return { upload, linked: await referenced(tx, name), changed: false };
  };
  if (!apply) return withReadTx(db, inspect);
  return withTx(db, async (tx) => {
    await lockImageAssetWork(tx);
    const current = await inspect(tx);
    if (current.upload.state === "abandoned") return current;
    const expected: Upload = {
      ...current.upload,
      state: "abandoned",
      abandonedAt: new Date(),
      abandonReason: reason,
    };
    const [changed] = await tx
      .update(localImageUploadTable)
      .set({
        state: expected.state,
        abandonedAt: expected.abandonedAt,
        abandonReason: expected.abandonReason,
      })
      .where(identity(current.upload))
      .returning({ filename: localImageUploadTable.filename });
    if (!changed) throw new Error("Image upload intent changed or is missing");
    if ((await referenced(tx, name)) !== current.linked)
      throw new Error("Image upload references changed during abandonment");
    const upload = await receipt(tx, expected);
    return { ...current, upload, changed: true };
  });
}

export async function listImageUploads(db: DB, all = false) {
  return withReadTx(db, (tx) =>
    tx
      .select()
      .from(localImageUploadTable)
      .where(all ? undefined : inArray(localImageUploadTable.state, ["pending", "installed"]))
      .orderBy(localImageUploadTable.createdAt, localImageUploadTable.filename),
  );
}

export async function pendingImageUploads(db: DB, root: string) {
  return withReadTx(db, async (tx) => {
    const pending = inArray(localImageUploadTable.state, ["pending", "installed"]);
    const [row] = await tx.select({ total: count() }).from(localImageUploadTable).where(pending);
    const rows = await tx
      .select()
      .from(localImageUploadTable)
      .where(pending)
      .orderBy(localImageUploadTable.createdAt, localImageUploadTable.filename)
      .limit(5);
    const named = [];
    for (const upload of rows)
      named.push({
        filename: upload.filename,
        state: upload.state,
        evidence: await inspectImageUpload(root, upload),
      });
    return { total: row.total, named };
  });
}
