/** Test-only restartable enablement. Production enrollment remains disabled. */
import { sql } from "drizzle-orm";
import { withReadTx, withTx, type DB, type Tx, type ReadTx } from "../../../core/src/database.js";
import {
  configureActionConnection,
  verifyActionConnection,
} from "../../../core/src/actions/connection.js";
import {
  parseAssetManifest,
  type AssetManifest,
  type ReadAsset,
} from "../../../core/src/actions/asset-manifest.js";
import { canonicalSchemaManifest } from "../../../core/src/generated/schema-manifest.js";
import { migrations } from "../../../core/src/generated/migrations.js";
import { readSchemaManifest } from "../../../core/src/migrations/schema-reader.js";
import { compareSchemaManifests } from "../../../core/src/migrations/schema.js";
import { validateMigrationHistory } from "../../../core/src/migrations/history.js";
import { installCapturePrototypeInTx } from "./action-capture.js";
import {
  beginCaptureEpochTransitionInTx,
  activateCaptureEpochInTx,
  prepareCaptureEpochBaseline,
  type PrototypeEpochTransition,
} from "./action-epochs.js";
import {
  reserveAssetManifestInTx,
  readAssetManifest,
  releaseAssetManifestInTx,
  type AssetManifestOwner,
} from "../db/api/asset-manifest.js";

export interface PrototypeCaptureInitialization {
  readonly id: string;
  readonly epochId: string;
  readonly schemaId: string;
}
const emptyAssets: AssetManifest = Object.freeze({ version: 1, entries: Object.freeze([]) });
const releaseReason = "Initial capture epoch activated";
const local = (tx: Tx | ReadTx) => tx as unknown as Parameters<typeof readAssetManifest>[0];
const localWrite = (tx: Tx) => tx as unknown as Parameters<typeof reserveAssetManifestInTx>[0];
function own(input: PrototypeCaptureInitialization) {
  const { id, epochId, schemaId } = input;
  if (
    [id, epochId, schemaId].some(
      (value) =>
        typeof value !== "string" ||
        !value.trim() ||
        value.length > 1000 ||
        value.includes("\0") ||
        !value.isWellFormed(),
    ) ||
    epochId === "initial" ||
    schemaId !== migrations.at(-1)!.id
  )
    throw Error("Invalid initial capture identity or schema");
  const request: PrototypeEpochTransition = Object.freeze({
    id,
    sourceEpoch: "initial",
    sourceSchema: schemaId,
    targetEpoch: epochId,
    targetSchema: schemaId,
    batches: Object.freeze([]),
  });
  return { identity: Object.freeze({ id, epochId, schemaId }), request };
}
export async function captureInitializationOwner(
  input: PrototypeCaptureInitialization,
): Promise<AssetManifestOwner> {
  const { identity } = own(input);
  const bytes = new TextEncoder().encode(
    JSON.stringify([identity.id, identity.epochId, identity.schemaId]),
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Object.freeze({
    kind: "pending-work",
    id:
      "prototype-initialization:v1:" +
      Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join(""),
  });
}
async function canonical(tx: Tx) {
  if ((await tx.values(sql`SELECT 1 FROM sqlite_temp_schema LIMIT 1`)).length)
    throw Error("Initial capture refuses temporary schema objects");
  const actual = await readSchemaManifest(async (query) =>
    (await tx.values(sql.raw(query))).map((row) => Array.from(row)),
  );
  if (!compareSchemaManifests(actual, canonicalSchemaManifest).matches)
    throw Error("Initial capture requires the canonical schema");
  const history = await tx.values(
    sql`SELECT hash,created_at FROM __drizzle_migrations ORDER BY created_at`,
  );
  validateMigrationHistory(
    history.map((row) => ({ hash: row[0], created_at: row[1] })),
    "complete",
  );
}
async function record(
  tx: Tx | ReadTx,
  request: PrototypeEpochTransition,
  owner: AssetManifestOwner,
) {
  if ((await tx.values(sql`SELECT 1 FROM sqlite_temp_schema LIMIT 1`)).length)
    throw Error("Initial capture refuses temporary schema objects");
  const rows = await tx.values(
    sql`SELECT request,state FROM capture_epoch_transition WHERE id=${request.id}`,
  );
  if (rows.length !== 1 || rows[0][0] !== JSON.stringify(request))
    throw Error("Initial capture request is missing or different");
  const pin = await readAssetManifest(local(tx), owner);
  if (
    ![pin.record.createdAt, pin.record.verifiedAt, pin.record.releasedAt].every(
      (date) => date === null || Number.isSafeInteger(date.getTime()),
    )
  )
    throw Error("Initial capture owner timestamps cannot be represented safely");
  const baseline = await tx.values(
    sql`SELECT asset_manifest FROM capture_baseline WHERE singleton=1`,
  );
  if (
    baseline.length !== 1 ||
    pin.record.manifest !== JSON.stringify(parseAssetManifest(JSON.parse(String(baseline[0][0]))))
  )
    throw Error("Initial capture image requirements changed");
  const state = String(rows[0][1]);
  if (state === "active" && pin.record.state !== "pending" && pin.record.state !== "retained")
    throw Error("Initial capture staging protection is not active");
  if (
    state === "completed" &&
    (pin.record.state !== "released" || pin.record.releaseReason !== releaseReason)
  )
    throw Error("Initial capture staging completion is inconsistent");
  return { state, pin };
}
/** Schema, initial write blocking and pending image protection become durable together. */
export async function stageCaptureInitialization(
  db: DB,
  input: PrototypeCaptureInitialization,
  catalog: AssetManifest = emptyAssets,
) {
  const { identity, request } = own(input),
    assets = parseAssetManifest(catalog),
    owner = await captureInitializationOwner(identity);
  return withTx(db, async (tx) => {
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await tx.run(sql`UPDATE main.namespace SET name=name WHERE 0`);
    const existing = await tx.values(
      sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='capture_epoch'`,
    );
    if (existing.length) {
      const current = await record(tx, request, owner);
      if (current.state === "active") await beginCaptureEpochTransitionInTx(tx, request);
      else await activateCaptureEpochInTx(tx, request);
      return Object.freeze({ changed: false, request, owner });
    }
    await canonical(tx);
    await installCapturePrototypeInTx(tx, assets, async (handle, publication) => {
      if (publication.kind !== "baseline") throw Error("Unexpected initial capture publication");
      await reserveAssetManifestInTx(localWrite(handle), owner, publication.manifest);
    });
    await beginCaptureEpochTransitionInTx(tx, request);
    await record(tx, request, owner);
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return Object.freeze({ changed: true, request, owner });
  });
}
/** Baseline validation and candidate protection reuse the restartable epoch protocol. */
export async function prepareCaptureInitialization(
  db: DB,
  input: PrototypeCaptureInitialization,
  createValidationDatabase: () => Promise<DB>,
  catalog: AssetManifest = emptyAssets,
  readAsset?: ReadAsset,
) {
  const { identity, request } = own(input),
    assets = parseAssetManifest(catalog),
    owner = await captureInitializationOwner(identity);
  await withReadTx(db, async (tx) => {
    const current = await record(tx, request, owner);
    if (current.state !== "active") throw Error("Initial capture is already active");
  });
  return prepareCaptureEpochBaseline(db, request, createValidationDatabase, assets, readAsset);
}
/** First activation and release of the initial staging pin share one commit. */
export async function activateCaptureInitialization(
  db: DB,
  input: PrototypeCaptureInitialization,
  readAsset?: ReadAsset,
) {
  const { identity, request } = own(input),
    owner = await captureInitializationOwner(identity);
  return withTx(db, async (tx) => {
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await tx.run(sql`UPDATE capture_epoch SET epoch_id=epoch_id WHERE 0`);
    await record(tx, request, owner);
    const activated = await activateCaptureEpochInTx(tx, request, readAsset);
    if (activated.changed) {
      await releaseAssetManifestInTx(localWrite(tx), owner, releaseReason);
      await record(tx, request, owner);
    }
    await verifyActionConnection((query) => tx.values(sql.raw(query)));
    return Object.freeze(activated);
  });
}
