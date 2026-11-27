/** Local upload bookkeeping shares the writer lock with reference changes and cleanup. */
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "../database.js";
import { localImageUploadTable } from "../schema.js";

export async function lockImageAssetWork(tx: Tx): Promise<void> {
  // Acquire SQLite's writer lock before inspecting references or local pins, even on deferred adapters.
  await tx.run(sql`UPDATE local_image_upload SET state=state WHERE 0`);
}

type PinSnapshot = {
  filename: string;
  state: string;
  metadata: string;
  createdReal: number | null;
  installedReal: number | null;
  completionType: string;
  completionValue: string | null;
  linked: number;
};

/** Keep local timestamps opaque, with separate REAL values to detect text-format rounding. */
function pinSnapshots(tx: Tx, where: SQL) {
  return tx.all<PinSnapshot>(sql`SELECT filename,state,
    json_array(typeof(byte_length),hex(byte_length),typeof(sha256),hex(sha256),
      typeof(created_at),hex(created_at),typeof(installed_at),hex(installed_at),
      typeof(error),hex(error),typeof(abandoned_at),hex(abandoned_at),
      typeof(abandon_reason),hex(abandon_reason)) AS metadata,
    CASE WHEN typeof(created_at)='real' THEN created_at ELSE NULL END AS createdReal,
    CASE WHEN typeof(installed_at)='real' THEN installed_at ELSE NULL END AS installedReal,
    typeof(completed_at) AS completionType,CAST(completed_at AS TEXT) AS completionValue,
    EXISTS(SELECT 1 FROM card WHERE card.content='kozane-image:/api/images/' || local_image_upload.filename) AS linked
    FROM local_image_upload WHERE ${where} ORDER BY filename`);
}

/** Bind one ID list so imported pin sets do not exceed SQLite's parameter limit. */
function namedPins(names: readonly string[]) {
  return sql`${localImageUploadTable.filename} IN (SELECT value FROM json_each(${JSON.stringify(names)}))`;
}

export async function completeImageUploadsInTx(tx: Tx): Promise<void> {
  await lockImageAssetWork(tx);
  const before = await pinSnapshots(tx, sql`state IN ('pending','installed')`);
  const candidates = before.filter((row) => row.state === "installed" && row.linked === 1);
  if (!candidates.length) return;
  const [{ now }] = await tx.all<{ now: number }>(
    sql`SELECT CAST(strftime('%s','now') AS INTEGER) AS now`,
  );
  const names = candidates.map((row) => row.filename);
  await tx.run(sql`UPDATE local_image_upload SET state='completed',completed_at=${now}
    WHERE state='installed' AND ${namedPins(names)}
    AND EXISTS(SELECT 1 FROM card WHERE card.content='kozane-image:/api/images/' || local_image_upload.filename)`);
  const selected = new Set(names);
  const expected = before.map((row) =>
    selected.has(row.filename)
      ? { ...row, state: "completed", completionType: "integer", completionValue: String(now) }
      : row,
  );
  const after = await pinSnapshots(tx, namedPins(before.map((row) => row.filename)));
  const fields: (keyof PinSnapshot)[] = [
    "filename",
    "state",
    "metadata",
    "createdReal",
    "installedReal",
    "completionType",
    "completionValue",
    "linked",
  ];
  if (
    after.length !== expected.length ||
    expected.some((row, index) =>
      fields.some((field) => !Object.is(after[index][field], row[field])),
    )
  )
    throw new Error("Image upload completion changed or is missing");
  const [remaining] = await tx.all<{ filename: string }>(sql`SELECT filename FROM local_image_upload
    WHERE state='installed' AND EXISTS(SELECT 1 FROM card WHERE card.content='kozane-image:/api/images/' || local_image_upload.filename) LIMIT 1`);
  if (remaining) throw new Error("Image upload completion selection changed");
}

export async function pinnedImageNames(tx: Tx): Promise<Set<string>> {
  const rows = await tx.all<{ filename: string }>(
    sql`SELECT filename FROM local_image_upload WHERE state IN ('pending','installed')`,
  );
  return new Set(rows.map((row) => row.filename));
}

export async function abandonedImageNames(tx: Tx): Promise<Set<string>> {
  const rows = await tx.all<{ filename: string }>(
    sql`SELECT filename FROM local_image_upload WHERE state='abandoned'`,
  );
  return new Set(rows.map((row) => row.filename));
}
