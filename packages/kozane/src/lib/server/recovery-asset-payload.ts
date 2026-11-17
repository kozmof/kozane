/** Store registered manifests against both saved source payloads. Complete bundle publication is separate. */
import { sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseRecoveryAssetPayload,
  requireRecoveryAssetCheckpoint,
  inspectRecoveryAssetCheckpoint,
  readRecoveryAssetCheckpoint,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  type RecoveryAssetCheckpoint,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpointKey,
} from "@kozane/core/recovery";
import { loadRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { loadRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import {
  observe,
  publishRecoveryPayload,
  directory,
  paths,
  readEntry,
  sameFile,
} from "./recovery-payload-files.js";

export class RecoveryAssetPayloadError extends Error {
  override readonly name = "RecoveryAssetPayloadError";
}
const area = "asset-manifests";
type Options = {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  localMaxBytes: number;
  sharedMaxBytes: number;
  createValidationDatabase: () => Promise<DB>;
};
function context(options: Options) {
  const { root, db, localMaxBytes, sharedMaxBytes, createValidationDatabase } = options;
  if (![localMaxBytes, sharedMaxBytes].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new RecoveryAssetPayloadError("Payload read limits must be positive safe integers");
  return {
    root,
    db,
    localMaxBytes,
    sharedMaxBytes,
    createValidationDatabase,
    expected: parseLocalRecoveryIdentity(options.expected),
  };
}
type Context = ReturnType<typeof context>;
function keyOf(expected: LocalRecoveryIdentity) {
  const { workspaceId, deviceId, epochId, checkpointId } = expected;
  return { workspaceId, deviceId, epochId, checkpointId };
}
async function checkpointFor(ctx: Context) {
  const checkpoint = await inspectRecoveryAssetCheckpoint(ctx.db, keyOf(ctx.expected));
  if (!checkpoint)
    throw new RecoveryAssetPayloadError("Trusted asset checkpoint is not registered");
  if (JSON.stringify(checkpoint.binding.checkpoint.identity) !== JSON.stringify(ctx.expected))
    throw new RecoveryAssetPayloadError("Registered asset checkpoint identity mismatch");
  if (
    checkpoint.binding.localCheckpoint.byteLength > ctx.localMaxBytes ||
    checkpoint.binding.checkpoint.byteLength > ctx.sharedMaxBytes
  )
    throw new RecoveryAssetPayloadError("Registered source payload exceeds read limit");
  return checkpoint;
}
async function requireBinding(tx: Tx, checkpoint: RecoveryAssetCheckpoint) {
  const key = keyOf(checkpoint.binding.checkpoint.identity);
  const assets = await readRecoveryAssetCheckpoint(tx, key);
  const shared = await readSharedRecoveryCheckpoint(tx, key);
  const local = await readLocalRecoveryCheckpoint(tx, key);
  if (
    !assets ||
    JSON.stringify(assets) !== JSON.stringify(checkpoint) ||
    !shared ||
    JSON.stringify(shared) !== JSON.stringify(checkpoint.binding) ||
    !local ||
    JSON.stringify(local) !== JSON.stringify(checkpoint.binding.localCheckpoint)
  )
    throw new RecoveryAssetPayloadError("Registered asset or source checkpoint binding changed");
}
async function requireSourceFiles(root: string, checkpoint: RecoveryAssetCheckpoint) {
  for (const [sourceArea, descriptor] of [
    ["checkpoints", checkpoint.binding.localCheckpoint],
    ["shared-history", checkpoint.binding.checkpoint],
  ] as const) {
    const evidence = await observe(root, descriptor, sourceArea);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new RecoveryAssetPayloadError(`Saved ${sourceArea} payload needs review`);
  }
}
async function requireReady(tx: Tx, ctx: Context, checkpoint: RecoveryAssetCheckpoint) {
  await requireBinding(tx, checkpoint);
  await requireSourceFiles(ctx.root, checkpoint);
}
async function sources(ctx: Context, checkpoint: RecoveryAssetCheckpoint) {
  const local = await loadRegisteredLocalRecoveryPayload({ ...ctx, maxBytes: ctx.localMaxBytes });
  const shared = await loadRegisteredSharedRecoveryPayload({
    ...ctx,
    maxBytes: ctx.sharedMaxBytes,
  });
  if (
    JSON.stringify(local.checkpoint) !== JSON.stringify(checkpoint.binding.localCheckpoint) ||
    JSON.stringify(shared.binding) !== JSON.stringify(checkpoint.binding)
  )
    throw new RecoveryAssetPayloadError("Saved source payload bindings changed");
  return { localSnapshot: local.snapshot, sharedHistory: shared.payload };
}
function canonical(input: unknown, checkpoint: RecoveryAssetCheckpoint) {
  const payload = parseRecoveryAssetPayload(input);
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (
    JSON.stringify(payload.binding) !== JSON.stringify(checkpoint.binding) ||
    bytes.byteLength !== checkpoint.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256
  )
    throw new RecoveryAssetPayloadError("Registered asset payload content mismatch");
  return { payload, bytes };
}
async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new RecoveryAssetPayloadError("Temporary asset payload needs review");
}

/** Inspect original asset metadata and file evidence, including orphaned registrations. */
export async function inspectRegisteredRecoveryAssetPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const checkpoint = await inspectRecoveryAssetCheckpoint(db, key);
  if (!checkpoint)
    throw new RecoveryAssetPayloadError("Trusted asset checkpoint is not registered");
  return { checkpoint, ...(await observe(root, checkpoint, area)) };
}

/** Verify all three expectations and both saved sources before exclusive manifest publication. */
export async function saveRegisteredRecoveryAssetPayload(options: Options & { input: unknown }) {
  const ctx = context(options);
  const input = parseRecoveryAssetPayload(options.input);
  const checkpoint = await checkpointFor(ctx);
  const { payload, bytes } = canonical(input, checkpoint);
  const contents = await sources(ctx, checkpoint);
  await requireRecoveryAssetCheckpoint(payload, checkpoint, ctx.expected, contents);
  return withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_assets SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      ctx.root,
      area,
      checkpoint,
      bytes,
      () => requireReady(tx, ctx, checkpoint),
      RecoveryAssetPayloadError,
    );
    return { path: published.path, checkpoint, changed: published.changed };
  });
}

/** Read bounded published manifest bytes, validate both saved sources, then recheck files and all catalogs. */
export async function loadRegisteredRecoveryAssetPayload(options: Options & { maxBytes: number }) {
  const ctx = context(options);
  const { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RecoveryAssetPayloadError("Payload read limit must be a positive safe integer");
  const checkpoint = await checkpointFor(ctx);
  if (checkpoint.byteLength > maxBytes)
    throw new RecoveryAssetPayloadError("Registered asset payload exceeds read limit");
  const loaded = await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_assets SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    const files = paths(await directory(ctx.root, false, area), checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new RecoveryAssetPayloadError(`Registered asset payload is ${file.evidence}`);
    await requireNoTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new RecoveryAssetPayloadError("Registered asset payload is not valid UTF-8 JSON", {
      cause,
    });
  }
  const { payload } = canonical(input, checkpoint);
  const contents = await sources(ctx, checkpoint);
  await requireRecoveryAssetCheckpoint(payload, checkpoint, ctx.expected, contents);
  await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_assets SET descriptor=descriptor WHERE 0`);
    await requireReady(tx, ctx, checkpoint);
    const files = paths(await directory(ctx.root, false, area), checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new RecoveryAssetPayloadError("Registered asset payload changed during validation");
  });
  return Object.freeze({ payload, checkpoint });
}
