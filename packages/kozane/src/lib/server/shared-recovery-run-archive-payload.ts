/** Persist broader retained runs against all five original source expectations. */
import { sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseSharedRecoveryRunArchive,
  validateSharedRecoveryRunArchive,
  inspectSharedRecoveryRunArchiveCheckpoint,
  readSharedRecoveryRunArchiveCheckpoint,
  readSharedRecoveryActionArchiveCheckpoint,
  readSharedRecoveryActionCheckpoint,
  readSharedRecoveryExecutionCheckpoint,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpointKey,
  type SharedRecoveryRunArchiveCheckpointBinding,
} from "@kozane/core/recovery";
import { loadRegisteredSharedRecoveryActionArchivePayload } from "./shared-recovery-action-archive-payload.js";
import { loadRegisteredSharedRecoveryActionPayload } from "./shared-recovery-action-payload.js";
import { loadRegisteredSharedRecoveryExecutionPayload } from "./shared-recovery-execution-payload.js";
import { loadRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import {
  observe,
  publishRecoveryPayload,
  directory,
  paths,
  readEntry,
  sameFile,
} from "./recovery-payload-files.js";

export class SharedRecoveryRunArchivePayloadError extends Error {
  override readonly name = "SharedRecoveryRunArchivePayloadError";
}
const area = "run-archives";
type Options = {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  localMaxBytes: number;
  sharedMaxBytes: number;
  executionMaxBytes: number;
  actionMaxBytes: number;
  actionArchiveMaxBytes: number;
  createValidationDatabase: () => Promise<DB>;
};
function context(options: Options) {
  const {
    root,
    db,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
    createValidationDatabase,
  } = options;
  if (
    ![
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      actionArchiveMaxBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new SharedRecoveryRunArchivePayloadError(
      "Payload read limits must be positive safe integers",
    );
  return {
    root,
    db,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
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
  const binding = await inspectSharedRecoveryRunArchiveCheckpoint(ctx.db, keyOf(ctx.expected));
  if (!binding)
    throw new SharedRecoveryRunArchivePayloadError("Trusted archive checkpoint is not registered");
  const original = binding.checkpoint.checkpoint.checkpoint,
    execution = original.checkpoint;
  if (JSON.stringify(execution.checkpoint.identity) !== JSON.stringify(ctx.expected))
    throw new SharedRecoveryRunArchivePayloadError(
      "Registered archive checkpoint identity mismatch",
    );
  if (
    binding.localCheckpoint.byteLength > ctx.localMaxBytes ||
    execution.checkpoint.byteLength > ctx.sharedMaxBytes ||
    execution.byteLength > ctx.executionMaxBytes ||
    original.byteLength > ctx.actionMaxBytes ||
    binding.checkpoint.checkpoint.byteLength > ctx.actionArchiveMaxBytes
  )
    throw new SharedRecoveryRunArchivePayloadError("Registered source payload exceeds read limit");
  return binding;
}
async function requireBinding(tx: Tx, binding: SharedRecoveryRunArchiveCheckpointBinding) {
  const original = binding.checkpoint.checkpoint.checkpoint,
    execution = original.checkpoint,
    key = keyOf(execution.checkpoint.identity);
  const archive = await readSharedRecoveryRunArchiveCheckpoint(tx, key);
  const originalArchive = await readSharedRecoveryActionArchiveCheckpoint(tx, key);
  const actions = await readSharedRecoveryActionCheckpoint(tx, key);
  const executions = await readSharedRecoveryExecutionCheckpoint(tx, key);
  const shared = await readSharedRecoveryCheckpoint(tx, key);
  const local = await readLocalRecoveryCheckpoint(tx, key);
  if (
    !archive ||
    JSON.stringify(archive) !== JSON.stringify(binding) ||
    !originalArchive ||
    JSON.stringify(originalArchive.checkpoint) !== JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(originalArchive.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !actions ||
    JSON.stringify(actions.checkpoint) !== JSON.stringify(original) ||
    JSON.stringify(actions.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !executions ||
    JSON.stringify(executions.checkpoint) !== JSON.stringify(execution) ||
    JSON.stringify(executions.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !shared ||
    JSON.stringify(shared.checkpoint) !== JSON.stringify(execution.checkpoint) ||
    JSON.stringify(shared.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !local ||
    JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryRunArchivePayloadError(
      "Registered archive or source checkpoint binding changed",
    );
}
async function requireReady(
  tx: Tx,
  ctx: Context,
  binding: SharedRecoveryRunArchiveCheckpointBinding,
) {
  await requireBinding(tx, binding);
  for (const [sourceArea, checkpoint] of [
    ["checkpoints", binding.localCheckpoint],
    ["shared-history", binding.checkpoint.checkpoint.checkpoint.checkpoint.checkpoint],
    ["executions", binding.checkpoint.checkpoint.checkpoint.checkpoint],
    ["actions", binding.checkpoint.checkpoint.checkpoint],
    ["action-archives", binding.checkpoint.checkpoint],
  ] as const) {
    const evidence = await observe(ctx.root, checkpoint, sourceArea);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new SharedRecoveryRunArchivePayloadError(`Saved ${sourceArea} payload needs review`);
  }
}
async function sources(ctx: Context, binding: SharedRecoveryRunArchiveCheckpointBinding) {
  // Each source loader validates its saved dependencies and original catalog bindings.
  const actionArchive = await loadRegisteredSharedRecoveryActionArchivePayload({
    ...ctx,
    maxBytes: ctx.actionArchiveMaxBytes,
  });
  const originals = await loadRegisteredSharedRecoveryActionPayload({
    ...ctx,
    maxBytes: ctx.actionMaxBytes,
  });
  const executions = await loadRegisteredSharedRecoveryExecutionPayload({
    ...ctx,
    maxBytes: ctx.executionMaxBytes,
  });
  // Reopen selected executions and shared rows for archive source verification.
  const shared = await loadRegisteredSharedRecoveryPayload({
    ...ctx,
    maxBytes: ctx.sharedMaxBytes,
  });
  if (
    JSON.stringify(actionArchive.binding.checkpoint) !==
      JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(actionArchive.binding.localCheckpoint) !==
      JSON.stringify(binding.localCheckpoint) ||
    JSON.stringify(originals.binding.checkpoint) !==
      JSON.stringify(binding.checkpoint.checkpoint.checkpoint) ||
    JSON.stringify(originals.binding.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    JSON.stringify(executions.binding.checkpoint) !==
      JSON.stringify(binding.checkpoint.checkpoint.checkpoint.checkpoint) ||
    JSON.stringify(executions.binding.localCheckpoint) !==
      JSON.stringify(binding.localCheckpoint) ||
    JSON.stringify(shared.binding.checkpoint) !==
      JSON.stringify(binding.checkpoint.checkpoint.checkpoint.checkpoint.checkpoint) ||
    JSON.stringify(shared.binding.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryRunArchivePayloadError("Saved archive source bindings changed");
  return {
    actionArchive: actionArchive.payload,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  };
}
function canonical(input: unknown, binding: SharedRecoveryRunArchiveCheckpointBinding) {
  const payload = parseSharedRecoveryRunArchive(input),
    checkpoint = binding.checkpoint;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (
    JSON.stringify(payload.checkpoint) !== JSON.stringify(checkpoint.checkpoint) ||
    JSON.stringify(payload.selection) !== JSON.stringify(checkpoint.selection) ||
    bytes.byteLength !== checkpoint.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256
  )
    throw new SharedRecoveryRunArchivePayloadError("Registered archive payload content mismatch");
  return { payload, bytes };
}
async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new SharedRecoveryRunArchivePayloadError("Temporary archive payload needs review");
}

/** Inspect archive evidence, including orphaned metadata, without authorizing publication or loading. */
export async function inspectRegisteredSharedRecoveryRunArchivePayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const binding = await inspectSharedRecoveryRunArchiveCheckpoint(db, key);
  if (!binding)
    throw new SharedRecoveryRunArchivePayloadError("Trusted archive checkpoint is not registered");
  return { binding, ...(await observe(root, binding.checkpoint, area)) };
}

/** Validate every archived run and saved source before synced exclusive publication. */
export async function saveRegisteredSharedRecoveryRunArchivePayload(
  options: Options & { input: unknown },
) {
  const ctx = context(options),
    input = parseSharedRecoveryRunArchive(options.input);
  const binding = await bindingFor(ctx),
    { payload, bytes } = canonical(input, binding);
  const source = await sources(ctx, binding);
  await validateSharedRecoveryRunArchive(
    ctx.createValidationDatabase,
    payload,
    binding.checkpoint,
    ctx.expected,
    source,
  );
  return withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_run_archives SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      ctx.root,
      area,
      binding.checkpoint,
      bytes,
      () => requireReady(tx, ctx, binding),
      SharedRecoveryRunArchivePayloadError,
    );
    return { path: published.path, binding, changed: published.changed };
  });
}

/** Reopen bounded canonical bytes and saved sources, then recheck files and all six catalog bindings. */
export async function loadRegisteredSharedRecoveryRunArchivePayload(
  options: Options & { maxBytes: number },
) {
  const ctx = context(options),
    { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new SharedRecoveryRunArchivePayloadError(
      "Payload read limit must be a positive safe integer",
    );
  const binding = await bindingFor(ctx);
  if (binding.checkpoint.byteLength > maxBytes)
    throw new SharedRecoveryRunArchivePayloadError("Registered archive payload exceeds read limit");
  const loaded = await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_run_archives SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, binding);
    const files = paths(await directory(ctx.root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, binding.checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new SharedRecoveryRunArchivePayloadError(
        `Registered archive payload is ${file.evidence}`,
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
    throw new SharedRecoveryRunArchivePayloadError(
      "Registered archive payload is not valid UTF-8 JSON",
      { cause },
    );
  }
  const { payload } = canonical(input, binding),
    source = await sources(ctx, binding);
  await validateSharedRecoveryRunArchive(
    ctx.createValidationDatabase,
    payload,
    binding.checkpoint,
    ctx.expected,
    source,
  );
  await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_run_archives SET descriptor=descriptor WHERE 0`);
    await requireReady(tx, ctx, binding);
    const files = paths(await directory(ctx.root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new SharedRecoveryRunArchivePayloadError(
        "Registered archive payload changed during validation",
      );
  });
  return Object.freeze({ payload, binding });
}
