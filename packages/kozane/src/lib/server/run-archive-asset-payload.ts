/** Persist broader run manifests against all seven exact saved recovery sources. */
import { sql } from "drizzle-orm";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTx, withReadTx, type DB, type Tx, type ReadTx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseRunArchiveAssetPayload,
  requireRunArchiveAssetCheckpoint,
  inspectRunArchiveAssetCheckpoint,
  readRunArchiveAssetCheckpoint,
  readSharedRecoveryRunArchiveCheckpoint,
  readSharedRecoveryActionArchiveCheckpoint,
  readSharedRecoveryActionCheckpoint,
  readSharedRecoveryExecutionCheckpoint,
  readSharedRecoveryCheckpoint,
  readLocalRecoveryCheckpoint,
  readRecoveryAssetCheckpoint,
  type LocalRecoveryIdentity,
  type LocalRecoveryCheckpointKey,
  type RunArchiveAssetCheckpoint,
} from "@kozane/core/recovery";
import { loadRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { loadRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { loadRegisteredSharedRecoveryExecutionPayload } from "./shared-recovery-execution-payload.js";
import { loadRegisteredSharedRecoveryActionArchivePayload } from "./shared-recovery-action-archive-payload.js";
import { loadRegisteredSharedRecoveryActionPayload } from "./shared-recovery-action-payload.js";
import { loadRegisteredSharedRecoveryRunArchivePayload } from "./shared-recovery-run-archive-payload.js";
import { loadRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import {
  observe,
  publishRecoveryPayload,
  directory,
  paths,
  readEntry,
  sameFile,
} from "./recovery-payload-files.js";

export class RunArchiveAssetPayloadError extends Error {
  override readonly name = "RunArchiveAssetPayloadError";
}
const area = "run-asset-manifests";
type Options = {
  root: string;
  db: DB;
  expected: LocalRecoveryIdentity;
  localMaxBytes: number;
  sharedMaxBytes: number;
  executionMaxBytes: number;
  actionMaxBytes: number;
  actionArchiveMaxBytes: number;
  runArchiveMaxBytes: number;
  assetMaxBytes: number;
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
    runArchiveMaxBytes,
    assetMaxBytes,
    createValidationDatabase,
  } = options;
  if (
    ![
      localMaxBytes,
      sharedMaxBytes,
      executionMaxBytes,
      actionMaxBytes,
      actionArchiveMaxBytes,
      runArchiveMaxBytes,
      assetMaxBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new RunArchiveAssetPayloadError("Payload read limits must be positive safe integers");
  return {
    root,
    db,
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
    runArchiveMaxBytes,
    assetMaxBytes,
    createValidationDatabase,
    expected: parseLocalRecoveryIdentity(options.expected),
  };
}
type Context = ReturnType<typeof context>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function keyOf(identity: LocalRecoveryIdentity) {
  const { workspaceId, deviceId, epochId, checkpointId } = identity;
  return { workspaceId, deviceId, epochId, checkpointId };
}
async function checkpointFor(ctx: Context) {
  return withReadTx(ctx.db, async (tx) => {
    const checkpoint = await readRunArchiveAssetCheckpoint(tx, keyOf(ctx.expected));
    if (!checkpoint)
      throw new RunArchiveAssetPayloadError(
        "Trusted run archive asset checkpoint is not registered",
      );
    if (!same(checkpoint.binding.localCheckpoint.identity, ctx.expected))
      throw new RunArchiveAssetPayloadError(
        "Registered run archive asset checkpoint identity mismatch",
      );
    const runs = checkpoint.binding.checkpoint,
      archive = runs.checkpoint,
      original = archive.checkpoint,
      execution = original.checkpoint;
    if (
      checkpoint.binding.localCheckpoint.byteLength > ctx.localMaxBytes ||
      execution.checkpoint.byteLength > ctx.sharedMaxBytes ||
      execution.byteLength > ctx.executionMaxBytes ||
      original.byteLength > ctx.actionMaxBytes ||
      archive.byteLength > ctx.actionArchiveMaxBytes ||
      runs.byteLength > ctx.runArchiveMaxBytes ||
      checkpoint.assetCheckpoint.byteLength > ctx.assetMaxBytes
    )
      throw new RunArchiveAssetPayloadError("Registered source payload exceeds read limit");
    await requireBinding(tx, checkpoint);
    return checkpoint;
  });
}
async function requireBinding(tx: Tx | ReadTx, checkpoint: RunArchiveAssetCheckpoint) {
  const { binding, assetCheckpoint } = checkpoint,
    runs = binding.checkpoint,
    archive = runs.checkpoint,
    original = archive.checkpoint,
    execution = original.checkpoint,
    key = keyOf(binding.localCheckpoint.identity);
  const assets = await readRunArchiveAssetCheckpoint(tx, key),
    history = await readSharedRecoveryRunArchiveCheckpoint(tx, key),
    archived = await readSharedRecoveryActionArchiveCheckpoint(tx, key),
    originals = await readSharedRecoveryActionCheckpoint(tx, key),
    executions = await readSharedRecoveryExecutionCheckpoint(tx, key),
    shared = await readSharedRecoveryCheckpoint(tx, key),
    local = await readLocalRecoveryCheckpoint(tx, key),
    current = await readRecoveryAssetCheckpoint(tx, key);
  if (
    !assets ||
    !same(assets, checkpoint) ||
    !history ||
    !same(history, binding) ||
    !archived ||
    !same(archived, { checkpoint: archive, localCheckpoint: binding.localCheckpoint }) ||
    !originals ||
    !same(originals, { checkpoint: original, localCheckpoint: binding.localCheckpoint }) ||
    !executions ||
    !same(executions, { checkpoint: execution, localCheckpoint: binding.localCheckpoint }) ||
    !shared ||
    !same(shared, { checkpoint: execution.checkpoint, localCheckpoint: binding.localCheckpoint }) ||
    !local ||
    !same(local, binding.localCheckpoint) ||
    !current ||
    !same(current, assetCheckpoint)
  )
    throw new RunArchiveAssetPayloadError(
      "Registered run archive asset or source checkpoint binding changed",
    );
}
async function requireReady(tx: Tx, ctx: Context, checkpoint: RunArchiveAssetCheckpoint) {
  await requireBinding(tx, checkpoint);
  const { binding } = checkpoint,
    runs = binding.checkpoint,
    archive = runs.checkpoint,
    original = archive.checkpoint,
    execution = original.checkpoint;
  for (const [sourceArea, descriptor] of [
    ["checkpoints", binding.localCheckpoint],
    ["shared-history", execution.checkpoint],
    ["executions", execution],
    ["actions", original],
    ["action-archives", archive],
    ["run-archives", runs],
    ["asset-manifests", checkpoint.assetCheckpoint],
  ] as const) {
    const evidence = await observe(ctx.root, descriptor, sourceArea);
    if (evidence.published !== "matching-content" || evidence.temporary !== "absent")
      throw new RunArchiveAssetPayloadError(`Saved ${sourceArea} payload needs review`);
  }
}
async function sources(ctx: Context, checkpoint: RunArchiveAssetCheckpoint) {
  // Each loader validates its own original bindings and saved dependencies, including isolated SQL checks.
  const runs = await loadRegisteredSharedRecoveryRunArchivePayload({
    ...ctx,
    maxBytes: ctx.runArchiveMaxBytes,
  });
  const archive = await loadRegisteredSharedRecoveryActionArchivePayload({
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
  const shared = await loadRegisteredSharedRecoveryPayload({
    ...ctx,
    maxBytes: ctx.sharedMaxBytes,
  });
  const local = await loadRegisteredLocalRecoveryPayload({ ...ctx, maxBytes: ctx.localMaxBytes });
  // Original-only requirements live in this broader manifest's originalImages, not in the current asset payload.
  const current = await loadRegisteredRecoveryAssetPayload({
    root: ctx.root,
    db: ctx.db,
    expected: ctx.expected,
    localMaxBytes: ctx.localMaxBytes,
    sharedMaxBytes: ctx.sharedMaxBytes,
    createValidationDatabase: ctx.createValidationDatabase,
    maxBytes: ctx.assetMaxBytes,
  });
  const { binding } = checkpoint;
  if (
    !same(runs.binding, binding) ||
    !same(archive.binding, {
      checkpoint: binding.checkpoint.checkpoint,
      localCheckpoint: binding.localCheckpoint,
    }) ||
    !same(originals.binding, {
      checkpoint: binding.checkpoint.checkpoint.checkpoint,
      localCheckpoint: binding.localCheckpoint,
    }) ||
    !same(executions.binding, {
      checkpoint: binding.checkpoint.checkpoint.checkpoint.checkpoint,
      localCheckpoint: binding.localCheckpoint,
    }) ||
    !same(shared.binding, checkpoint.assetCheckpoint.binding) ||
    !same(local.checkpoint, binding.localCheckpoint) ||
    !same(current.checkpoint, checkpoint.assetCheckpoint)
  )
    throw new RunArchiveAssetPayloadError("Saved run archive asset source bindings changed");
  return {
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    executions: executions.payload,
    originalActions: originals.payload,
    actionArchive: archive.payload,
    runArchive: runs.payload,
    currentAssets: current.payload,
  };
}
function canonical(input: unknown, checkpoint: RunArchiveAssetCheckpoint) {
  const payload = parseRunArchiveAssetPayload(input),
    bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (
    !same(payload.binding, checkpoint.binding) ||
    !same(payload.assetCheckpoint, checkpoint.assetCheckpoint) ||
    bytes.byteLength !== checkpoint.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256
  )
    throw new RunArchiveAssetPayloadError("Registered run archive asset payload content mismatch");
  return { payload, bytes };
}
async function requireNoTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new RunArchiveAssetPayloadError("Temporary run archive asset payload needs review");
}
/** Inspect historical or orphaned file evidence without creating paths or authorizing publication or loading. */
export async function inspectRegisteredRunArchiveAssetPayload(
  root: string,
  db: DB,
  key: LocalRecoveryCheckpointKey,
) {
  const checkpoint = await inspectRunArchiveAssetCheckpoint(db, key);
  if (!checkpoint)
    throw new RunArchiveAssetPayloadError("Trusted run archive asset checkpoint is not registered");
  return { checkpoint, ...(await observe(root, checkpoint, area)) };
}
/** Validate all saved sources and per-run image metadata before synced exclusive publication. */
export async function saveRegisteredRunArchiveAssetPayload(options: Options & { input: unknown }) {
  const ctx = context(options),
    input = parseRunArchiveAssetPayload(options.input),
    checkpoint = await checkpointFor(ctx),
    { payload, bytes } = canonical(input, checkpoint);
  const source = await sources(ctx, checkpoint);
  await requireRunArchiveAssetCheckpoint(payload, checkpoint, ctx.expected, source);
  return withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_run_assets SET descriptor=descriptor WHERE 0`);
    const published = await publishRecoveryPayload(
      ctx.root,
      area,
      checkpoint,
      bytes,
      () => requireReady(tx, ctx, checkpoint),
      RunArchiveAssetPayloadError,
    );
    return { path: published.path, checkpoint, changed: published.changed };
  });
}
/** Reopen bounded canonical bytes, validate all seven sources, then recheck all files and eight original expectations. */
export async function loadRegisteredRunArchiveAssetContents(
  options: Options & { maxBytes: number },
) {
  const ctx = context(options),
    { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RunArchiveAssetPayloadError("Payload read limit must be a positive safe integer");
  const checkpoint = await checkpointFor(ctx);
  if (checkpoint.byteLength > maxBytes)
    throw new RunArchiveAssetPayloadError(
      "Registered run archive asset payload exceeds read limit",
    );
  const loaded = await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_run_assets SET descriptor=descriptor WHERE 0`);
    await requireBinding(tx, checkpoint);
    const files = paths(await directory(ctx.root, false, area), checkpoint);
    await requireNoTemporary(files.temporary);
    const file = await readEntry(files.published, checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new RunArchiveAssetPayloadError(
        `Registered run archive asset payload is ${file.evidence}`,
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
    throw new RunArchiveAssetPayloadError(
      "Registered run archive asset payload is not valid UTF-8 JSON",
      { cause },
    );
  }
  const { payload } = canonical(input, checkpoint),
    source = await sources(ctx, checkpoint);
  await requireRunArchiveAssetCheckpoint(payload, checkpoint, ctx.expected, source);
  await withTx(ctx.db, async (tx) => {
    await tx.run(sql`UPDATE local_recovery_run_assets SET descriptor=descriptor WHERE 0`);
    await requireReady(tx, ctx, checkpoint);
    const files = paths(await directory(ctx.root, false, area), checkpoint);
    await requireNoTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new RunArchiveAssetPayloadError(
        "Registered run archive asset payload changed during validation",
      );
  });
  return Object.freeze({ payload, checkpoint, sources: Object.freeze(source) });
}

/** Reopen the manifest through the same complete source validation used by bundle assembly. */
export async function loadRegisteredRunArchiveAssetPayload(
  options: Options & { maxBytes: number },
) {
  const { payload, checkpoint } = await loadRegisteredRunArchiveAssetContents(options);
  return Object.freeze({ payload, checkpoint });
}
