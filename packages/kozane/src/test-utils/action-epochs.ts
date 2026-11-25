/** Test-only durable migration boundary. This is not the production epoch or log schema. */
import { sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../../../core/src/database.js";
import {
  configureActionConnection,
  verifyActionConnection,
} from "../../../core/src/actions/connection.js";
import { captureRowSql } from "../../../core/src/actions/sql-codec.js";
import { ROW_ENCODING_VERSION } from "../../../core/src/actions/row-codec.js";
import { createRowProjection } from "../../../core/src/actions/projection.js";
import {
  baselineAssetNames,
  selectAssetManifest,
  parseAssetManifest,
  verifyAssetManifest,
  type AssetManifest,
  type ReadAsset,
} from "../../../core/src/actions/asset-manifest.js";
import { migrations } from "../../../core/src/generated/migrations.js";
import { capturedTables, captureApplicationRows } from "./action-tables.js";
import { validateApplicationProjection } from "./action-validation.js";

type Handle = Tx | ReadTx;
export interface PrototypeEpochTransition {
  readonly id: string;
  readonly sourceEpoch: string;
  readonly sourceSchema: string;
  readonly targetEpoch: string;
  readonly targetSchema: string;
  readonly batches: readonly string[];
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const missingAsset: ReadAsset = async () => {
  throw Error("Epoch baseline requires an asset reader");
};
function own(input: PrototypeEpochTransition): PrototypeEpochTransition {
  const { id, sourceEpoch, sourceSchema, targetEpoch, targetSchema } = input;
  const batches = [...input.batches];
  if (
    [id, sourceEpoch, sourceSchema, targetEpoch, targetSchema, ...batches].some(
      (value) =>
        typeof value !== "string" || !value.trim() || value.length > 1000 || value.includes("\0"),
    ) ||
    sourceEpoch === targetEpoch ||
    new Set(batches).size !== batches.length
  )
    throw Error("Invalid prototype epoch transition");
  return Object.freeze({
    id,
    sourceEpoch,
    sourceSchema,
    targetEpoch,
    targetSchema,
    batches: Object.freeze(batches),
  });
}
/** SQL guards allow migration only with an exact hook-owned batch marker and active transition. */
export const prototypeMigrationAuthority = `EXISTS(SELECT 1 FROM capture_context c JOIN capture_migration_boundary b ON b.singleton=c.singleton JOIN capture_epoch_transition t ON t.id=b.transition_id JOIN capture_epoch e ON e.singleton=c.singleton WHERE c.singleton=1 AND c.mode='migrate' AND c.run_id IS NULL AND c.action_id IS NULL AND c.execution_ord IS NULL AND c.next_effect_ord=0 AND t.state='active' AND t.next_batch=b.batch AND t.next_batch<json_array_length(t.batches) AND t.source_epoch=e.epoch_id AND t.source_schema=e.schema_id)`;
export const prototypeNoTransition = `NOT EXISTS(SELECT 1 FROM capture_epoch_transition WHERE state='active')`;
export async function installCaptureEpochPrototype(tx: Tx) {
  await tx.run(
    sql`CREATE TABLE capture_epoch(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch_id TEXT NOT NULL UNIQUE,schema_id TEXT NOT NULL)`,
  );
  await tx.run(sql`INSERT INTO capture_epoch VALUES(1,'initial',${migrations.at(-1)!.id})`);
  await tx.run(
    sql`CREATE TABLE capture_epoch_transition(id TEXT PRIMARY KEY,request TEXT NOT NULL,source_epoch TEXT NOT NULL,source_schema TEXT NOT NULL,batches TEXT NOT NULL,next_batch INTEGER NOT NULL DEFAULT 0 CHECK(next_batch>=0 AND next_batch<=json_array_length(batches)),state TEXT NOT NULL CHECK(state IN ('active','completed')),history TEXT NOT NULL,candidate TEXT)`,
  );
  await tx.run(
    sql`CREATE UNIQUE INDEX capture_one_transition ON capture_epoch_transition(state) WHERE state='active'`,
  );
  await tx.run(
    sql`CREATE TABLE capture_migration_boundary(singleton INTEGER PRIMARY KEY CHECK(singleton=1),transition_id TEXT,batch INTEGER,CHECK((transition_id IS NULL)=(batch IS NULL)))`,
  );
  await tx.run(sql`INSERT INTO capture_migration_boundary VALUES(1,NULL,NULL)`);
  await tx.run(
    sql`CREATE TABLE capture_migration_history(transition_id TEXT NOT NULL REFERENCES capture_epoch_transition(id),batch INTEGER NOT NULL,batch_id TEXT NOT NULL,PRIMARY KEY(transition_id,batch))`,
  );
  await tx.run(
    sql`CREATE TABLE capture_epoch_archive(epoch_id TEXT PRIMARY KEY,schema_id TEXT NOT NULL,baseline TEXT NOT NULL,selection TEXT NOT NULL)`,
  );
  await tx.run(
    sql`CREATE TABLE capture_guard_catalog(name TEXT PRIMARY KEY,definition TEXT NOT NULL)`,
  );
}
export async function rememberCaptureGuards(tx: Tx) {
  await tx.run(
    sql`INSERT INTO capture_guard_catalog SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'capture_*'`,
  );
}
export async function requireCaptureEpochRecordMode(tx: Handle) {
  if ((await tx.values(sql`SELECT 1 FROM capture_epoch_transition WHERE state='active'`)).length)
    throw Error("Application writes are blocked by an epoch transition");
}
async function empty(tx: Handle) {
  const rows = await tx.values(
    sql`SELECT 1 FROM capture_context c JOIN capture_migration_boundary b USING(singleton) WHERE c.singleton=1 AND c.mode='record' AND c.run_id IS NULL AND c.action_id IS NULL AND c.execution_ord IS NULL AND c.next_effect_ord=0 AND b.transition_id IS NULL AND b.batch IS NULL`,
  );
  if (
    rows.length !== 1 ||
    (await tx.values(sql`SELECT 1 FROM capture_run WHERE complete<>1 LIMIT 1`)).length
  )
    throw Error("Epoch transition requires empty execution and migration markers");
}
async function guards(tx: Handle) {
  const expected = await tx.values(
    sql`SELECT name,definition FROM capture_guard_catalog ORDER BY name`,
  );
  if (expected.length !== capturedTables.length * 3)
    throw Error("Missing epoch capture guard catalog");
  const actual = await tx.values(
    sql`SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'capture_*' ORDER BY name`,
  );
  if (
    !same(
      actual.map((row) => Array.from(row)),
      expected.map((row) => Array.from(row)),
    )
  )
    throw Error("Epoch capture guards changed or disappeared");
}
async function schema(tx: Handle) {
  return JSON.stringify(
    (
      await tx.values(
        sql`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name`,
      )
    ).map((row) => Array.from(row)),
  );
}
async function history(tx: Handle) {
  const result: Record<string, string[]> = {};
  for (const name of [
    "capture_baseline",
    "capture_selection",
    "capture_run",
    "capture_execution",
    "capture_effect",
  ]) {
    const columns = (await tx.values(sql.raw(`PRAGMA table_info(${quote(name)})`))).map((row) =>
      String(row[1]),
    );
    result[name] = (
      await tx.values(sql.raw(`SELECT ${captureRowSql(columns)} FROM ${quote(name)}`))
    )
      .map((row) => String(row[0]))
      .sort();
  }
  return JSON.stringify(result);
}
async function currentEpoch(tx: Handle) {
  const rows = await tx.values(sql`SELECT epoch_id,schema_id FROM capture_epoch WHERE singleton=1`);
  if (rows.length !== 1) throw Error("Missing active prototype epoch");
  return { epochId: String(rows[0][0]), schemaId: String(rows[0][1]) };
}
async function transition(tx: Handle, request: PrototypeEpochTransition) {
  const rows = await tx.values(
    sql`SELECT request,next_batch,state,history,candidate,source_epoch,source_schema,batches FROM capture_epoch_transition WHERE id=${request.id}`,
  );
  if (
    rows.length !== 1 ||
    rows[0][0] !== JSON.stringify(request) ||
    rows[0][5] !== request.sourceEpoch ||
    rows[0][6] !== request.sourceSchema ||
    rows[0][7] !== JSON.stringify(request.batches)
  )
    throw Error("Epoch transition request is missing or changed");
  const next = rows[0][1];
  if (!Number.isSafeInteger(next) || Number(next) < 0 || Number(next) > request.batches.length)
    throw Error("Invalid migration progress");
  const completed = await tx.values(
    sql`SELECT batch,batch_id FROM capture_migration_history WHERE transition_id=${request.id} ORDER BY batch`,
  );
  if (
    !same(
      completed.map((row) => Array.from(row)),
      request.batches.slice(0, Number(next)).map((id, i) => [i, id]),
    )
  )
    throw Error("Migration history disagrees with progress");
  return {
    next: Number(next),
    state: String(rows[0][2]),
    history: String(rows[0][3]),
    candidate: rows[0][4] as string | null,
  };
}
async function active(tx: Handle, request: PrototypeEpochTransition) {
  const stored = await transition(tx, request),
    epoch = await currentEpoch(tx);
  if (
    stored.state !== "active" ||
    epoch.epochId !== request.sourceEpoch ||
    epoch.schemaId !== request.sourceSchema
  )
    throw Error("Epoch transition is not active for the source epoch");
  if (stored.history !== (await history(tx)))
    throw Error("Archived epoch history changed during migration");
  return stored;
}
async function locked(tx: Tx) {
  await tx.run(sql`UPDATE capture_epoch SET epoch_id=epoch_id WHERE 0`);
  await configureActionConnection((query) => tx.values(sql.raw(query)));
  await empty(tx);
}
export function beginCaptureEpochTransition(db: DB, input: PrototypeEpochTransition) {
  const request = own(input);
  return withTx(db, async (tx) => {
    await locked(tx);
    const existing = await tx.values(
      sql`SELECT id FROM capture_epoch_transition WHERE id=${request.id}`,
    );
    if (existing.length) {
      await active(tx, request);
      return { changed: false };
    }
    await requireCaptureEpochRecordMode(tx);
    const epoch = await currentEpoch(tx);
    if (epoch.epochId !== request.sourceEpoch || epoch.schemaId !== request.sourceSchema)
      throw Error("Epoch transition source identity mismatch");
    if (
      (
        await tx.values(
          sql`SELECT 1 FROM capture_epoch_archive WHERE epoch_id=${request.targetEpoch}`,
        )
      ).length
    )
      throw Error("Target epoch identity was already used");
    await guards(tx);
    await tx.run(
      sql`INSERT INTO capture_epoch_transition(id,request,source_epoch,source_schema,batches,state,history) VALUES(${request.id},${JSON.stringify(request)},${request.sourceEpoch},${request.sourceSchema},${JSON.stringify(request.batches)},'active',${await history(tx)})`,
    );
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return { changed: true };
  });
}
/** Committed batches acknowledge retries without invoking the supplied repair callback. */
export function runCaptureMigrationBatch(
  db: DB,
  input: PrototypeEpochTransition,
  index: number,
  migrate: (tx: Tx) => Promise<void>,
) {
  const request = own(input);
  if (!Number.isSafeInteger(index) || index < 0 || index >= request.batches.length)
    throw Error("Invalid migration batch index");
  return withTx(db, async (tx) => {
    await locked(tx);
    const stored = await active(tx, request);
    await guards(tx);
    if (index < stored.next) return { changed: false };
    if (index !== stored.next || stored.candidate !== null)
      throw Error("Migration batch is out of order");
    await tx.run(
      sql`UPDATE capture_migration_boundary SET transition_id=${request.id},batch=${index} WHERE singleton=1`,
    );
    await tx.run(sql`UPDATE capture_context SET mode='migrate' WHERE singleton=1`);
    await migrate(tx);
    if ((await tx.values(sql.raw(`SELECT 1 WHERE ${prototypeMigrationAuthority}`))).length !== 1)
      throw Error("Migration boundary marker changed");
    const afterHook = await transition(tx, request);
    if (
      afterHook.next !== stored.next ||
      afterHook.candidate !== stored.candidate ||
      afterHook.state !== stored.state ||
      afterHook.history !== stored.history
    )
      throw Error("Migration callback changed transition progress or candidate");
    if ((await tx.values(sql`PRAGMA foreign_key_check`)).length)
      throw Error("Migration foreign-key check failed");
    await guards(tx);
    if (stored.history !== (await history(tx)))
      throw Error("Migration changed archived action history");
    await tx.run(sql`UPDATE capture_context SET mode='record' WHERE singleton=1`);
    await tx.run(
      sql`UPDATE capture_migration_boundary SET transition_id=NULL,batch=NULL WHERE singleton=1`,
    );
    await tx.run(
      sql`INSERT INTO capture_migration_history VALUES(${request.id},${index},${request.batches[index]})`,
    );
    await tx.run(
      sql`UPDATE capture_epoch_transition SET next_batch=next_batch+1 WHERE id=${request.id}`,
    );
    await active(tx, request);
    await empty(tx);
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return { changed: true };
  });
}
async function hash(input: unknown) {
  const data = new TextEncoder().encode(JSON.stringify(input)),
    digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
}
/** Validate a candidate outside the live transaction, then retain it without activating writes. */
export async function prepareCaptureEpochBaseline(
  db: DB,
  input: PrototypeEpochTransition,
  createValidationDatabase: () => Promise<DB>,
  catalog: AssetManifest = { version: 1, entries: [] },
  readAsset: ReadAsset = missingAsset,
) {
  const request = own(input),
    assets = parseAssetManifest(catalog);
  const candidate = await withReadTx(db, async (tx) => {
    await empty(tx);
    const stored = await active(tx, request);
    if (stored.next !== request.batches.length) throw Error("Migration batches are incomplete");
    await guards(tx);
    const rows = await captureApplicationRows(tx),
      manifest = selectAssetManifest(assets, baselineAssetNames(rows));
    return {
      epochId: request.targetEpoch,
      schemaId: request.targetSchema,
      encoding: ROW_ENCODING_VERSION,
      rows,
      assets: manifest,
      schema: await schema(tx),
    };
  });
  await verifyAssetManifest(candidate.assets, baselineAssetNames(candidate.rows), readAsset);
  await validateApplicationProjection(
    async () => {
      const validation = await createValidationDatabase();
      if (validation === db) throw Error("Epoch validation requires a separate database");
      return validation;
    },
    createRowProjection(capturedTables, candidate.rows),
  );
  const descriptor = JSON.stringify({ ...candidate, sha256: await hash(candidate) });
  return withTx(db, async (tx) => {
    await locked(tx);
    const stored = await active(tx, request);
    await guards(tx);
    if (
      stored.next !== request.batches.length ||
      !same(await captureApplicationRows(tx), candidate.rows) ||
      (await schema(tx)) !== candidate.schema
    )
      throw Error("Epoch candidate changed during validation");
    if (stored.candidate !== null && stored.candidate !== descriptor)
      throw Error("A different epoch baseline was already prepared");
    await tx.run(
      sql`UPDATE capture_epoch_transition SET candidate=${descriptor} WHERE id=${request.id}`,
    );
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return { changed: stored.candidate === null, sha256: JSON.parse(descriptor).sha256 as string };
  });
}
/** Old runs remain archived. Only a verified new baseline and empty selection become active. */
export async function activateCaptureEpoch(
  db: DB,
  input: PrototypeEpochTransition,
  readAsset: ReadAsset = missingAsset,
) {
  const request = own(input);
  return withTx(db, async (tx) => {
    await locked(tx);
    const stored = await transition(tx, request),
      epoch = await currentEpoch(tx);
    if (stored.state === "completed") {
      if (epoch.epochId !== request.targetEpoch || epoch.schemaId !== request.targetSchema)
        throw Error("Completed epoch is no longer active");
      await guards(tx);
      return { changed: false };
    }
    await active(tx, request);
    if (stored.next !== request.batches.length || stored.candidate === null)
      throw Error("Epoch activation requires a prepared baseline");
    const { sha256, ...candidate } = JSON.parse(stored.candidate);
    if (
      sha256 !== (await hash(candidate)) ||
      candidate.epochId !== request.targetEpoch ||
      candidate.schemaId !== request.targetSchema ||
      candidate.encoding !== ROW_ENCODING_VERSION ||
      candidate.schema !== (await schema(tx)) ||
      !same(candidate.rows, await captureApplicationRows(tx))
    )
      throw Error("Prepared epoch baseline changed");
    const manifest = parseAssetManifest(candidate.assets);
    if (!same(selectAssetManifest(manifest, baselineAssetNames(candidate.rows)), manifest))
      throw Error("Prepared epoch image requirements changed");
    await verifyAssetManifest(manifest, baselineAssetNames(candidate.rows), readAsset);
    if (
      candidate.schema !== (await schema(tx)) ||
      !same(candidate.rows, await captureApplicationRows(tx))
    )
      throw Error("Prepared epoch baseline changed during image verification");
    await guards(tx);
    const baseline = await tx.values(
        sql`SELECT row_encoding_ver,rows,asset_manifest FROM capture_baseline WHERE singleton=1`,
      ),
      selection = await tx.values(
        sql`SELECT position,run_id FROM capture_selection ORDER BY position`,
      );
    await tx.run(
      sql`INSERT INTO capture_epoch_archive VALUES(${request.sourceEpoch},${request.sourceSchema},${JSON.stringify(baseline.map((row) => Array.from(row)))},${JSON.stringify(selection.map((row) => Array.from(row)))})`,
    );
    await tx.run(
      sql`UPDATE capture_baseline SET row_encoding_ver=${ROW_ENCODING_VERSION},rows=${JSON.stringify(candidate.rows)},asset_manifest=${JSON.stringify(manifest)} WHERE singleton=1`,
    );
    await tx.run(sql`DELETE FROM capture_selection`);
    await tx.run(
      sql`UPDATE capture_epoch SET epoch_id=${request.targetEpoch},schema_id=${request.targetSchema} WHERE singleton=1`,
    );
    await tx.run(sql`UPDATE capture_epoch_transition SET state='completed' WHERE id=${request.id}`);
    await empty(tx);
    await requireCaptureEpochRecordMode(tx);
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return { changed: true };
  });
}
