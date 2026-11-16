/** Local upload bookkeeping shares the writer lock with reference changes and cleanup. */
import { sql } from "drizzle-orm";
import type { Tx } from "../database.js";

export async function lockImageAssetWork(tx: Tx): Promise<void> {
  // Acquire SQLite's writer lock before inspecting references or local pins, even on deferred adapters.
  await tx.run(sql`UPDATE local_image_upload SET state=state WHERE 0`);
}

export async function completeImageUploadsInTx(tx: Tx): Promise<void> {
  await tx.run(sql`UPDATE local_image_upload SET state='completed',completed_at=CAST(strftime('%s','now') AS INTEGER)
    WHERE state='installed' AND EXISTS(SELECT 1 FROM card WHERE card.content='kozane-image:/api/images/' || local_image_upload.filename)`);
}

export async function pinnedImageNames(tx: Tx): Promise<Set<string>> {
  const rows = await tx.all<{ filename: string }>(
    sql`SELECT filename FROM local_image_upload WHERE state IN ('pending','installed')`,
  );
  return new Set(rows.map((row) => row.filename));
}
