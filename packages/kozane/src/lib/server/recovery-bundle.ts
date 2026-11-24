/** Publish and reopen complete recovery indexes against registered payloads and protected images. */
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { withTx, withReadTx, type Tx } from "../../db/database.js";
import {
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
  parseRecoveryBundleIndex,
  requireRecoveryBundleCheckpoint,
  type RecoveryBundleCheckpoint,
  type RecoveryBundleIndex,
} from "@kozane/core/recovery";
import { loadRegisteredRunArchiveAssetContents } from "./run-archive-asset-payload.js";
import {
  requireRecoveryCheckpointImageBindings,
  reservePreparedRecoveryCheckpointImages,
  retainPreparedRecoveryCheckpointImagesInTx,
  verifyPreparedRecoveryCheckpointImagesInTx,
} from "./recovery-checkpoint-images.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import { readAssetManifest } from "../../db/api/asset-manifest.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import {
  observe,
  publishRecoveryPayload,
  directory,
  paths,
  readEntry,
  sameFile,
} from "./recovery-payload-files.js";

export class RecoveryBundleError extends Error {
  override readonly name = "RecoveryBundleError";
}
const area = "bundle-indexes";
type Options = Omit<Parameters<typeof loadRegisteredRunArchiveAssetContents>[0], "maxBytes"> & {
  checkpoint: RecoveryBundleCheckpoint;
  runAssetMaxBytes: number;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function bindings(checkpoint: RecoveryBundleCheckpoint) {
  const cp = checkpoint.runAssetCheckpoint,
    localCheckpoint = cp.binding.localCheckpoint,
    archive = cp.binding.checkpoint.checkpoint,
    original = archive.checkpoint;
  return {
    binding: cp.assetCheckpoint.binding,
    assetCheckpoint: cp.assetCheckpoint,
    executionBinding: { checkpoint: original.checkpoint, localCheckpoint },
    actionBinding: { checkpoint: original, localCheckpoint },
    actionArchiveBinding: { checkpoint: archive, localCheckpoint },
    runArchiveBinding: cp.binding,
    runAssetCheckpoint: cp,
  };
}
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
    runAssetMaxBytes,
    createValidationDatabase,
  } = options;
  const limits = [
    localMaxBytes,
    sharedMaxBytes,
    executionMaxBytes,
    actionMaxBytes,
    actionArchiveMaxBytes,
    runArchiveMaxBytes,
    assetMaxBytes,
    runAssetMaxBytes,
  ];
  if (!limits.every((n) => Number.isSafeInteger(n) && n > 0))
    throw new RecoveryBundleError("Payload read limits must be positive safe integers");
  const expected = parseLocalRecoveryIdentity(options.expected),
    checkpoint = parseRecoveryBundleCheckpoint(options.checkpoint);
  if (!same(checkpoint.runAssetCheckpoint.binding.localCheckpoint.identity, expected))
    throw new RecoveryBundleError("Recovery bundle checkpoint identity mismatch");
  const cp = checkpoint.runAssetCheckpoint,
    runs = cp.binding.checkpoint,
    archive = runs.checkpoint,
    original = archive.checkpoint,
    executions = original.checkpoint;
  const descriptors = [
    cp.binding.localCheckpoint,
    executions.checkpoint,
    executions,
    original,
    archive,
    runs,
    cp.assetCheckpoint,
    cp,
  ];
  if (descriptors.some((descriptor, i) => descriptor.byteLength > limits[i]))
    throw new RecoveryBundleError("Registered source payload exceeds read limit");
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
    runAssetMaxBytes,
    createValidationDatabase,
    expected,
    checkpoint,
    bindings: bindings(checkpoint),
    owner: registeredLocalRecoveryImageOwner(expected),
  };
}
type Context = ReturnType<typeof context>;
function prepared(ctx: Context, index: RecoveryBundleIndex) {
  return {
    ...ctx.bindings,
    root: ctx.root,
    db: ctx.db,
    owner: ctx.owner,
    manifest: index.manifest,
  };
}
async function requireBindings(ctx: Context) {
  await withReadTx(ctx.db, (tx) => requireRecoveryCheckpointImageBindings(tx, ctx.bindings));
}
function canonical(input: unknown, checkpoint: RecoveryBundleCheckpoint) {
  const index = parseRecoveryBundleIndex(input),
    bytes = Buffer.from(JSON.stringify(index), "utf8");
  if (
    !same(index.runAssetCheckpoint, checkpoint.runAssetCheckpoint) ||
    bytes.length !== checkpoint.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256
  )
    throw new RecoveryBundleError("Recovery bundle index content mismatch");
  return { index, bytes };
}
async function sources(ctx: Context, index: RecoveryBundleIndex) {
  const loaded = await loadRegisteredRunArchiveAssetContents({
    ...ctx,
    maxBytes: ctx.runAssetMaxBytes,
  });
  if (!same(loaded.checkpoint, ctx.checkpoint.runAssetCheckpoint))
    throw new RecoveryBundleError("Original recovery bundle source binding changed");
  const contents = Object.freeze({ ...loaded.sources, runAssets: loaded.payload });
  await requireRecoveryBundleCheckpoint(index, ctx.checkpoint, ctx.expected, contents);
  return contents;
}
async function noTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new RecoveryBundleError("Temporary recovery bundle index needs review");
}
/** Observation alone never establishes source authenticity, image protection or completeness. */
export async function inspectRecoveryBundlePublication(
  root: string,
  input: RecoveryBundleCheckpoint,
) {
  const checkpoint = parseRecoveryBundleCheckpoint(input);
  return { checkpoint, ...(await observe(root, checkpoint, area)) };
}
/** Source validation precedes durable image reservation. Failure preserves every earlier pin and file. */
export async function saveRegisteredRecoveryBundle(options: Options & { input: unknown }) {
  const ctx = context(options),
    { index, bytes } = canonical(options.input, ctx.checkpoint);
  await requireBindings(ctx);
  await sources(ctx, index);
  const work = prepared(ctx, index);
  await reservePreparedRecoveryCheckpointImages(work);
  return withTx(ctx.db, async (tx) => {
    await lockImageAssetWork(tx);
    const published = await publishRecoveryPayload(
      ctx.root,
      area,
      ctx.checkpoint,
      bytes,
      async () => {
        await retainPreparedRecoveryCheckpointImagesInTx(tx, work);
      },
      RecoveryBundleError,
    );
    const files = paths(await directory(ctx.root, false, area), ctx.checkpoint);
    await noTemporary(files.temporary);
    if ((await readEntry(files.published, ctx.checkpoint)).evidence !== "matching-content")
      throw new RecoveryBundleError("Recovery bundle index changed during publication");
    return Object.freeze({
      path: published.path,
      index,
      checkpoint: ctx.checkpoint,
      owner: ctx.owner,
      changed: published.changed,
    });
  });
}
async function requireRetained(tx: Tx, ctx: Context, index: RecoveryBundleIndex) {
  const current = await readAssetManifest(tx, ctx.owner);
  if (current.record.state !== "retained" || !same(current.manifest, index.manifest))
    throw new RecoveryBundleError("Recovery bundle image protection is not retained or changed");
}
/** Revalidate all payloads and physical bytes. Pending or released owners never become usable by loading. */
export async function loadRegisteredRecoveryBundle(options: Options & { maxBytes: number }) {
  const ctx = context(options),
    { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RecoveryBundleError("Payload read limit must be a positive safe integer");
  if (ctx.checkpoint.byteLength > maxBytes)
    throw new RecoveryBundleError("Recovery bundle index exceeds read limit");
  await requireBindings(ctx);
  const loaded = await withTx(ctx.db, async (tx) => {
    await lockImageAssetWork(tx);
    await requireRecoveryCheckpointImageBindings(tx, ctx.bindings);
    const files = paths(await directory(ctx.root, false, area), ctx.checkpoint);
    await noTemporary(files.temporary);
    const file = await readEntry(files.published, ctx.checkpoint, true);
    if (file.evidence !== "matching-content" || !file.content || !file.identity)
      throw new RecoveryBundleError(`Recovery bundle index is ${file.evidence}`);
    await noTemporary(files.temporary);
    return { bytes: file.content, identity: file.identity };
  });
  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(loaded.bytes),
    );
  } catch (cause) {
    throw new RecoveryBundleError("Recovery bundle index is not valid UTF-8 JSON", { cause });
  }
  const { index } = canonical(input, ctx.checkpoint),
    contents = await sources(ctx, index),
    work = prepared(ctx, index);
  await withTx(ctx.db, async (tx) => {
    await lockImageAssetWork(tx);
    await requireRetained(tx, ctx, index);
    await verifyPreparedRecoveryCheckpointImagesInTx(tx, work);
    const files = paths(await directory(ctx.root, false, area), ctx.checkpoint);
    await noTemporary(files.temporary);
    const current = await fs.lstat(files.published, { bigint: true });
    if (!current.isFile() || !sameFile(current, loaded.identity))
      throw new RecoveryBundleError("Recovery bundle index changed during validation");
    await requireRetained(tx, ctx, index);
  });
  return Object.freeze({ index, checkpoint: ctx.checkpoint, owner: ctx.owner, contents });
}
