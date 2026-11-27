/** Persist selected execution data while preserving its original shared and local expectations. */
import { sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseSharedRecoveryExecutionHistory,
  requireSharedRecoveryExecutionCheckpoint,
  inspectSharedRecoveryExecutionCheckpoint,
  readSharedRecoveryExecutionCheckpoint,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpointKey,
  type SharedRecoveryExecutionCheckpointBinding,
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

export class SharedRecoveryExecutionPayloadError extends Error {
  override readonly name = "SharedRecoveryExecutionPayloadError";
}
const area = "executions";
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
    throw new SharedRecoveryExecutionPayloadError(
      "Payload read limits must be positive safe integers",
    );
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
function keyOf(identity: LocalRecoveryIdentity) {
  const { workspaceId, deviceId, epochId, checkpointId } = identity;
  return { workspaceId, deviceId, epochId, checkpointId };
}
async function bindingFor(ctx: Context) {
  const binding = await inspectSharedRecoveryExecutionCheckpoint(ctx.db, keyOf(ctx.expected));
  if (!binding)
    throw new SharedRecoveryExecutionPayloadError("Trusted execution checkpoint is not registered");
  if (JSON.stringify(binding.checkpoint.checkpoint.identity) !== JSON.stringify(ctx.expected))
    throw new SharedRecoveryExecutionPayloadError(
      "Registered execution checkpoint identity mismatch",
    );
  if (
    binding.localCheckpoint.byteLength > ctx.localMaxBytes ||
    binding.checkpoint.checkpoint.byteLength > ctx.sharedMaxBytes
  )
    throw new SharedRecoveryExecutionPayloadError("Registered source payload exceeds read limit");
  return binding;
}
async function requireBinding(tx: Tx, binding: SharedRecoveryExecutionCheckpointBinding) {
  const key = keyOf(binding.checkpoint.checkpoint.identity);
  const executions = await readSharedRecoveryExecutionCheckpoint(tx, key);
  const shared = await readSharedRecoveryCheckpoint(tx, key);
  const local = await readLocalRecoveryCheckpoint(tx, key);
  if (
    !executions ||
    JSON.stringify(executions) !== JSON.stringify(binding) ||
    !shared ||
    JSON.stringify(shared.checkpoint) !== JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(shared.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !local ||
    JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryExecutionPayloadError(
      "Registered execution or source checkpoint binding changed",
    );
}
async function requireReady(
  tx: Tx,
  ctx: Context,
  binding: SharedRecoveryExecutionCheckpointBinding,
) {
  await requireBinding(tx, binding);
  for (const [sourceArea, checkpoint] of [
    ["checkpoints", binding.localCheckpoint],
    ["shared-history", binding.checkpoint.checkpoint],
  ] as const) {
    const evidence = await observe(ctx.root, checkpoint, sourceArea);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new SharedRecoveryExecutionPayloadError(`Saved ${sourceArea} payload needs review`);
  }
}
async function source(ctx: Context, binding: SharedRecoveryExecutionCheckpointBinding) {
  const local = await loadRegisteredLocalRecoveryPayload({ ...ctx, maxBytes: ctx.localMaxBytes });
  const shared = await loadRegisteredSharedRecoveryPayload({
    ...ctx,
    maxBytes: ctx.sharedMaxBytes,
  });
  if (
    JSON.stringify(local.checkpoint) !== JSON.stringify(binding.localCheckpoint) ||
    JSON.stringify(shared.binding.checkpoint) !== JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(shared.binding.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryExecutionPayloadError("Saved execution source bindings changed");
  return shared.payload;
}
function canonical(input: unknown, binding: SharedRecoveryExecutionCheckpointBinding) {
  const payload = parseSharedRecoveryExecutionHistory(input);
  const checkpoint = binding.checkpoint;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (
    JSON.stringify(payload.checkpoint) !== JSON.stringify(checkpoint.checkpoint) ||
    JSON.stringify(payload.selection) !== JSON.stringify(checkpoint.selection) ||
    bytes.byteLength !== checkpoint.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256
  )
    throw new SharedRecoveryExecutionPayloadError("Registered execution payload content mismatch");
  return { payload, bytes };
}
async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new SharedRecoveryExecutionPayloadError("Temporary execution payload needs review");
}

/** Inspect retained execution evidence, including orphaned metadata, without authorizing loading or publication. */
export async function inspectRegisteredSharedRecoveryExecutionPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const binding = await inspectSharedRecoveryExecutionCheckpoint(db, key);
  if (!binding)
    throw new SharedRecoveryExecutionPayloadError("Trusted execution checkpoint is not registered");
  return { binding, ...(await observe(root, binding.checkpoint, area)) };
}

/** Validate all original expectations and both saved sources before synced exclusive publication. */
export async function saveRegisteredSharedRecoveryExecutionPayload(
  options: Options & { input: unknown },
) {
  const ctx = context(options),
    input = parseSharedRecoveryExecutionHistory(options.input);
  const binding = await bindingFor(ctx);
  const { payload, bytes } = canonical(input, binding);
  const sharedHistory = await source(ctx, binding);
  await requireSharedRecoveryExecutionCheckpoint(
    payload,
    binding.checkpoint,
    ctx.expected,
    sharedHistory,
  );
  return withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_executions SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      ctx.root,
      area,
      binding.checkpoint,
      bytes,
      () => requireReady(tx, ctx, binding),
      SharedRecoveryExecutionPayloadError,
    );
    return { path: published.path, binding, changed: published.changed };
  });
}

/** Reopen bounded canonical bytes and both saved sources, then recheck files and all three catalog bindings. */
export async function loadRegisteredSharedRecoveryExecutionPayload(
  options: Options & { maxBytes: number },
) {
  const ctx = context(options),
    { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new SharedRecoveryExecutionPayloadError(
      "Payload read limit must be a positive safe integer",
    );
  const binding = await bindingFor(ctx);
  if (binding.checkpoint.byteLength > maxBytes)
    throw new SharedRecoveryExecutionPayloadError(
      "Registered execution payload exceeds read limit",
    );
  const loaded = await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_executions SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, binding);
    const files = paths(await directory(ctx.root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, binding.checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new SharedRecoveryExecutionPayloadError(
        `Registered execution payload is ${file.evidence}`,
      );
    await requireNoTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new SharedRecoveryExecutionPayloadError(
      "Registered execution payload is not valid UTF-8 JSON",
      { cause },
    );
  }
  const { payload } = canonical(input, binding);
  const sharedHistory = await source(ctx, binding);
  await requireSharedRecoveryExecutionCheckpoint(
    payload,
    binding.checkpoint,
    ctx.expected,
    sharedHistory,
  );
  await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_executions SET descriptor=descriptor WHERE 0`);
    await requireReady(tx, ctx, binding);
    const files = paths(await directory(ctx.root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new SharedRecoveryExecutionPayloadError(
        "Registered execution payload changed during validation",
      );
  });
  return Object.freeze({ payload, binding });
}
