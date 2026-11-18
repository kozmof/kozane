/** Persist original action records against their exact execution, shared and local expectations. */
import { sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTx, type DB, type Tx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseSharedRecoveryActionHistory,
  requireSharedRecoveryActionCheckpoint,
  inspectSharedRecoveryActionCheckpoint,
  readSharedRecoveryActionCheckpoint,
  readSharedRecoveryExecutionCheckpoint,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpointKey,
  type SharedRecoveryActionCheckpointBinding,
} from "@kozane/core/recovery";
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

export class SharedRecoveryActionPayloadError extends Error {
  override readonly name = "SharedRecoveryActionPayloadError";
}
const area = "actions";
type Options = {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  localMaxBytes: number;
  sharedMaxBytes: number;
  executionMaxBytes: number;
  createValidationDatabase: () => Promise<DB>;
};
function context(options: Options) {
  const { root, db, localMaxBytes, sharedMaxBytes, executionMaxBytes, createValidationDatabase } =
    options;
  if (
    ![localMaxBytes, sharedMaxBytes, executionMaxBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new SharedRecoveryActionPayloadError(
      "Payload read limits must be positive safe integers",
    );
  return {
    root,
    db,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
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
  const binding = await inspectSharedRecoveryActionCheckpoint(ctx.db, keyOf(ctx.expected));
  if (!binding)
    throw new SharedRecoveryActionPayloadError("Trusted action checkpoint is not registered");
  const execution = binding.checkpoint.checkpoint;
  if (JSON.stringify(execution.checkpoint.identity) !== JSON.stringify(ctx.expected))
    throw new SharedRecoveryActionPayloadError("Registered action checkpoint identity mismatch");
  if (
    binding.localCheckpoint.byteLength > ctx.localMaxBytes ||
    execution.checkpoint.byteLength > ctx.sharedMaxBytes ||
    execution.byteLength > ctx.executionMaxBytes
  )
    throw new SharedRecoveryActionPayloadError("Registered source payload exceeds read limit");
  return binding;
}
async function requireBinding(tx: Tx, binding: SharedRecoveryActionCheckpointBinding) {
  const execution = binding.checkpoint.checkpoint,
    key = keyOf(execution.checkpoint.identity);
  const actions = await readSharedRecoveryActionCheckpoint(tx, key);
  const executions = await readSharedRecoveryExecutionCheckpoint(tx, key);
  const shared = await readSharedRecoveryCheckpoint(tx, key);
  const local = await readLocalRecoveryCheckpoint(tx, key);
  if (
    !actions ||
    JSON.stringify(actions) !== JSON.stringify(binding) ||
    !executions ||
    JSON.stringify(executions.checkpoint) !== JSON.stringify(execution) ||
    JSON.stringify(executions.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !shared ||
    JSON.stringify(shared.checkpoint) !== JSON.stringify(execution.checkpoint) ||
    JSON.stringify(shared.localCheckpoint) !== JSON.stringify(binding.localCheckpoint) ||
    !local ||
    JSON.stringify(local) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryActionPayloadError(
      "Registered action or source checkpoint binding changed",
    );
}
async function requireReady(tx: Tx, ctx: Context, binding: SharedRecoveryActionCheckpointBinding) {
  await requireBinding(tx, binding);
  for (const [sourceArea, checkpoint] of [
    ["checkpoints", binding.localCheckpoint],
    ["shared-history", binding.checkpoint.checkpoint.checkpoint],
    ["executions", binding.checkpoint.checkpoint],
  ] as const) {
    const evidence = await observe(ctx.root, checkpoint, sourceArea);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new SharedRecoveryActionPayloadError(`Saved ${sourceArea} payload needs review`);
  }
}
async function sources(ctx: Context, binding: SharedRecoveryActionCheckpointBinding) {
  // The execution loader validates both saved local/shared sources in isolated SQL databases.
  const executions = await loadRegisteredSharedRecoveryExecutionPayload({
    ...ctx,
    maxBytes: ctx.executionMaxBytes,
  });
  // Reopen the original shared payload for the action verifier, including its own exact SQL validation.
  const shared = await loadRegisteredSharedRecoveryPayload({
    ...ctx,
    maxBytes: ctx.sharedMaxBytes,
  });
  if (
    JSON.stringify(executions.binding.checkpoint) !==
      JSON.stringify(binding.checkpoint.checkpoint) ||
    JSON.stringify(executions.binding.localCheckpoint) !==
      JSON.stringify(binding.localCheckpoint) ||
    JSON.stringify(shared.binding.checkpoint) !==
      JSON.stringify(binding.checkpoint.checkpoint.checkpoint) ||
    JSON.stringify(shared.binding.localCheckpoint) !== JSON.stringify(binding.localCheckpoint)
  )
    throw new SharedRecoveryActionPayloadError("Saved action source bindings changed");
  return { executions: executions.payload, sharedHistory: shared.payload };
}
function canonical(input: unknown, binding: SharedRecoveryActionCheckpointBinding) {
  const payload = parseSharedRecoveryActionHistory(input),
    checkpoint = binding.checkpoint;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (
    JSON.stringify(payload.checkpoint) !== JSON.stringify(checkpoint.checkpoint) ||
    JSON.stringify(payload.selection) !== JSON.stringify(checkpoint.selection) ||
    bytes.byteLength !== checkpoint.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256
  )
    throw new SharedRecoveryActionPayloadError("Registered action payload content mismatch");
  return { payload, bytes };
}
async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new SharedRecoveryActionPayloadError("Temporary action payload needs review");
}

/** Inspect retained action evidence, including orphaned metadata, without authorizing loading or publication. */
export async function inspectRegisteredSharedRecoveryActionPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const binding = await inspectSharedRecoveryActionCheckpoint(db, key);
  if (!binding)
    throw new SharedRecoveryActionPayloadError("Trusted action checkpoint is not registered");
  return { binding, ...(await observe(root, binding.checkpoint, area)) };
}

/** Verify original action contents and all saved sources before synced exclusive publication. */
export async function saveRegisteredSharedRecoveryActionPayload(
  options: Options & { input: unknown },
) {
  const ctx = context(options),
    input = parseSharedRecoveryActionHistory(options.input);
  const binding = await bindingFor(ctx),
    { payload, bytes } = canonical(input, binding);
  const source = await sources(ctx, binding);
  await requireSharedRecoveryActionCheckpoint(
    payload,
    binding.checkpoint,
    ctx.expected,
    source.executions,
    source.sharedHistory,
  );
  return withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_actions SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      ctx.root,
      area,
      binding.checkpoint,
      bytes,
      () => requireReady(tx, ctx, binding),
      SharedRecoveryActionPayloadError,
    );
    return { path: published.path, binding, changed: published.changed };
  });
}

/** Reopen bounded canonical bytes and saved sources, then recheck files and all four catalog bindings. */
export async function loadRegisteredSharedRecoveryActionPayload(
  options: Options & { maxBytes: number },
) {
  const ctx = context(options),
    { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new SharedRecoveryActionPayloadError(
      "Payload read limit must be a positive safe integer",
    );
  const binding = await bindingFor(ctx);
  if (binding.checkpoint.byteLength > maxBytes)
    throw new SharedRecoveryActionPayloadError("Registered action payload exceeds read limit");
  const loaded = await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_actions SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, binding);
    const files = paths(await directory(ctx.root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, binding.checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new SharedRecoveryActionPayloadError(`Registered action payload is ${file.evidence}`);
    await requireNoTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new SharedRecoveryActionPayloadError(
      "Registered action payload is not valid UTF-8 JSON",
      { cause },
    );
  }
  const { payload } = canonical(input, binding),
    source = await sources(ctx, binding);
  await requireSharedRecoveryActionCheckpoint(
    payload,
    binding.checkpoint,
    ctx.expected,
    source.executions,
    source.sharedHistory,
  );
  await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_actions SET descriptor=descriptor WHERE 0`);
    await requireReady(tx, ctx, binding);
    const files = paths(await directory(ctx.root, false, area), binding.checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new SharedRecoveryActionPayloadError(
        "Registered action payload changed during validation",
      );
  });
  return Object.freeze({ payload, binding });
}
