import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../database.js";
import { localImageUploadTable } from "../schema.js";

export type ImageUploadRecord = typeof localImageUploadTable.$inferSelect;

/** Bind generated upload intent and every progress or decision field. */
export function imageUploadIdentity(row: ImageUploadRecord) {
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

/** Check the expected predicate after triggers before decoding any changed timestamps. */
export async function readImageUploadReceipt(tx: Tx, expected: ImageUploadRecord) {
  const upload = await tx
    .select()
    .from(localImageUploadTable)
    .where(imageUploadIdentity(expected))
    .get();
  if (!upload) throw new Error("Image upload publication changed or is missing");
  return upload;
}
