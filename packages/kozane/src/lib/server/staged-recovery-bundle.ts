/** Retain and reopen complete staged recovery artifacts independently of the source workspace. */
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import {
  inspectRecoveryStagingDestination,
  readRecoveryStagingDestination,
  parseLocalRecoveryIdentity,
  parseRecoveryBundleCheckpoint,
  parseRecoveryBundleIndex,
  requireRecoveryBundleCheckpoint,
  parseLocalRecoverySnapshot,
  parseSharedRecoveryHistoryPayload,
  parseSharedRecoveryExecutionHistory,
  parseSharedRecoveryActionHistory,
  parseSharedRecoveryActionArchive,
  parseSharedRecoveryRunArchive,
  parseRecoveryAssetPayload,
  parseRunArchiveAssetPayload,
  validateLocalRecoveryCheckpoint,
  validateSharedRecoveryCheckpoint,
  validateSharedRecoveryRunArchive,
  type RecoveryBundleIndex,
  type RecoveryBundleSources,
  type RecoveryStagingDestination,
  type LocalRecoveryIdentity,
  type RecoveryBundleCheckpoint,
} from "@kozane/core/recovery";
import {
  withTx,
  configureActionConnection,
  verifyActionConnection,
  type DB,
  type Tx,
} from "../../db/database.js";
import { lockImageAssetWork } from "../../db/api/image-upload.js";
import { readAssetManifest, type AssetManifestOwner } from "../../db/api/asset-manifest.js";
import { verifyRetainedImageManifestInTx } from "./image-manifest-retention.js";
import { loadRegisteredRecoveryBundle } from "./recovery-bundle.js";
import {
  registeredRecoveryDestinationImageOwner,
  type installRegisteredRecoveryBundleImages,
} from "./recovery-image-installation.js";
import {
  directory,
  paths,
  readEntry,
  sameFile,
  publishRecoveryPayload,
} from "./recovery-payload-files.js";

const area = "staged-bundles";
const names = [
  "localSnapshot",
  "sharedHistory",
  "executions",
  "originalActions",
  "actionArchive",
  "runArchive",
  "currentAssets",
  "runAssets",
] as const;
const limitNames = [
  "localMaxBytes",
  "sharedMaxBytes",
  "executionMaxBytes",
  "actionMaxBytes",
  "actionArchiveMaxBytes",
  "runArchiveMaxBytes",
  "assetMaxBytes",
  "runAssetMaxBytes",
  "maxBytes",
] as const;
type Limits = Pick<Parameters<typeof loadRegisteredRecoveryBundle>[0], (typeof limitNames)[number]>;
export type StagedRecoveryBundleOptions = Limits & {
  db: DB;
  root: string;
  checkpoint: RecoveryBundleCheckpoint;
  expected: LocalRecoveryIdentity;
  destinationExpected: LocalRecoveryIdentity;
  mode: RecoveryStagingDestination["mode"];
  createValidationDatabase: () => Promise<DB>;
};
export interface StagedRecoveryBundle extends RecoveryStagingDestination {
  readonly index: RecoveryBundleIndex;
  readonly contents: RecoveryBundleSources;
  readonly owner: AssetManifestOwner;
}
export class StagedRecoveryBundleError extends Error {
  override readonly name = "StagedRecoveryBundleError";
}
function own(options: StagedRecoveryBundleOptions) {
  const { db, root, mode, createValidationDatabase } = options;
  if (typeof root !== "string" || !root || root.includes("\0"))
    throw new StagedRecoveryBundleError("Staged bundle requires an explicit workspace root");
  const limits = Object.fromEntries(limitNames.map((name) => [name, options[name]])) as Limits;
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0))
    throw new StagedRecoveryBundleError("Payload read limits must be positive safe integers");
  const checkpoint = parseRecoveryBundleCheckpoint(options.checkpoint),
    expected = parseLocalRecoveryIdentity(options.expected),
    destinationExpected = parseLocalRecoveryIdentity(options.destinationExpected);
  const cp = checkpoint.runAssetCheckpoint,
    runs = cp.binding.checkpoint,
    originals = runs.checkpoint.checkpoint,
    executions = originals.checkpoint;
  const descriptors = [
    cp.binding.localCheckpoint,
    executions.checkpoint,
    executions,
    originals,
    runs.checkpoint,
    runs,
    cp.assetCheckpoint,
    cp,
    checkpoint,
  ];
  if (descriptors.some((descriptor, i) => descriptor.byteLength > limits[limitNames[i]]))
    throw new StagedRecoveryBundleError("Staged bundle payload exceeds read limit");
  return {
    ...limits,
    db,
    root: resolve(root),
    mode,
    createValidationDatabase,
    checkpoint,
    expected,
    destinationExpected,
    descriptors,
  };
}
type Context = ReturnType<typeof own>;
const staging = (ctx: Context) =>
  inspectRecoveryStagingDestination(
    ctx.db,
    ctx.checkpoint,
    ctx.expected,
    ctx.destinationExpected,
    ctx.mode,
  );
const checkStage = (tx: Tx, ctx: Context) =>
  readRecoveryStagingDestination(
    tx,
    ctx.checkpoint,
    ctx.expected,
    ctx.destinationExpected,
    ctx.mode,
  );
async function requireOwner(tx: Tx, owner: AssetManifestOwner, index: RecoveryBundleIndex) {
  const current = await readAssetManifest(tx, owner);
  if (
    current.record.state !== "retained" ||
    current.record.manifest !== JSON.stringify(index.manifest)
  )
    throw new StagedRecoveryBundleError(
      "Destination bundle image protection is not retained or changed",
    );
}
async function ready(tx: Tx, ctx: Context, owner: AssetManifestOwner, index: RecoveryBundleIndex) {
  await checkStage(tx, ctx);
  await requireOwner(tx, owner, index);
  await verifyRetainedImageManifestInTx(tx, ctx.root, owner);
  await verifyActionConnection((query) => tx.values(sql.raw(query)));
}
function contents(input: RecoveryBundleSources) {
  return Object.freeze({
    localSnapshot: parseLocalRecoverySnapshot(input.localSnapshot),
    sharedHistory: parseSharedRecoveryHistoryPayload(input.sharedHistory),
    executions: parseSharedRecoveryExecutionHistory(input.executions),
    originalActions: parseSharedRecoveryActionHistory(input.originalActions),
    actionArchive: parseSharedRecoveryActionArchive(input.actionArchive),
    runArchive: parseSharedRecoveryRunArchive(input.runArchive),
    currentAssets: parseRecoveryAssetPayload(input.currentAssets),
    runAssets: parseRunArchiveAssetPayload(input.runAssets),
  });
}
function bytes(input: unknown, descriptor: { byteLength: number; sha256: string }) {
  const result = Buffer.from(JSON.stringify(input), "utf8");
  if (
    result.length !== descriptor.byteLength ||
    createHash("sha256").update(result).digest("hex") !== descriptor.sha256
  )
    throw new StagedRecoveryBundleError(
      "Staged bundle canonical contents differ from expected bytes",
    );
  return result;
}
async function noTemporary(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new StagedRecoveryBundleError("Temporary staged bundle payload needs review");
}
async function readFiles(ctx: Context, collect: boolean) {
  const dir = await directory(ctx.root, false, area);
  const files = [];
  for (const descriptor of ctx.descriptors) {
    const file = paths(dir, descriptor);
    await noTemporary(file.temporary);
    const observed = await readEntry(file.published, descriptor, collect);
    if (
      observed.evidence !== "matching-content" ||
      !observed.identity ||
      (collect && !observed.content)
    )
      throw new StagedRecoveryBundleError(`Staged bundle payload is ${observed.evidence}`);
    await noTemporary(file.temporary);
    files.push(observed);
  }
  return files;
}
function decode(input: Buffer) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input));
  } catch (cause) {
    throw new StagedRecoveryBundleError("Staged bundle payload is not valid UTF-8 JSON", { cause });
  }
}

/** Images must already be installed. Publish the index only after all eight canonical payloads. */
export async function retainRegisteredRecoveryBundleInDestination(
  options: Parameters<typeof installRegisteredRecoveryBundleImages>[0],
): Promise<
  StagedRecoveryBundle & {
    readonly copied: number;
    readonly reused: number;
    readonly changed: boolean;
  }
> {
  const {
    db: sourceDb,
    root: sourcePath,
    destination,
    destinationRoot,
    createValidationDatabase,
  } = options;
  const ctx = own({ ...options, db: destination, root: destinationRoot });
  if (
    sourceDb === destination ||
    typeof sourcePath !== "string" ||
    !sourcePath ||
    sourcePath.includes("\0")
  )
    throw new StagedRecoveryBundleError(
      "Bundle retention requires separate source and destination workspaces",
    );
  const source = {
    ...(Object.fromEntries(limitNames.map((name) => [name, ctx[name]])) as Limits),
    db: sourceDb,
    root: resolve(sourcePath),
    checkpoint: ctx.checkpoint,
    expected: ctx.expected,
    createValidationDatabase: async () => {
      const validation = await createValidationDatabase();
      if (validation === sourceDb || validation === destination)
        throw new StagedRecoveryBundleError("Bundle validation requires a separate empty database");
      return validation;
    },
  };
  const metadata = await staging(ctx);
  const [sourceRoot, targetRoot] = await Promise.all([
    fs.realpath(source.root),
    fs.realpath(ctx.root),
  ]);
  const [a, b] = await Promise.all([
    fs.stat(sourceRoot, { bigint: true }),
    fs.stat(targetRoot, { bigint: true }),
  ]);
  if (
    !a.isDirectory() ||
    !b.isDirectory() ||
    sourceRoot === targetRoot ||
    (a.dev === b.dev && a.ino === b.ino)
  )
    throw new StagedRecoveryBundleError("Bundle retention requires separate workspace roots");
  ctx.root = targetRoot;
  source.root = sourceRoot;
  const loaded = await loadRegisteredRecoveryBundle(source),
    data = contents(loaded.contents),
    index = loaded.index,
    owner = registeredRecoveryDestinationImageOwner(metadata),
    payloads = [...names.map((name) => data[name]), index],
    buffers = payloads.map((payload, i) => bytes(payload, ctx.descriptors[i]));
  return withTx(destination, async (tx) => {
    await lockImageAssetWork(tx);
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await ready(tx, ctx, owner, index);
    let copied = 0;
    for (let i = 0; i < buffers.length; i++) {
      const published = await publishRecoveryPayload(
        ctx.root,
        area,
        ctx.descriptors[i],
        buffers[i],
        () => requireOwner(tx, owner, index),
        StagedRecoveryBundleError,
      );
      if (published.changed) copied++;
    }
    await readFiles(ctx, false);
    await ready(tx, ctx, owner, index);
    return Object.freeze({
      ...metadata,
      index,
      contents: data,
      owner,
      copied,
      reused: buffers.length - copied,
      changed: copied > 0,
    });
  });
}

/** No source workspace is required. Revalidate artifacts, isolated SQL states and retained destination images. */
export async function loadStagedRecoveryBundle(
  options: StagedRecoveryBundleOptions,
): Promise<StagedRecoveryBundle> {
  const ctx = own(options),
    metadata = await staging(ctx),
    owner = registeredRecoveryDestinationImageOwner(metadata);
  const loaded = await withTx(ctx.db, async (tx) => {
    await lockImageAssetWork(tx);
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await checkStage(tx, ctx);
    const current = await readAssetManifest(tx, owner);
    if (current.record.state !== "retained")
      throw new StagedRecoveryBundleError("Destination bundle image protection is not retained");
    return readFiles(ctx, true);
  });
  const input = Object.fromEntries(
      names.map((name, i) => [name, decode(loaded[i].content!)]),
    ) as unknown as RecoveryBundleSources,
    data = contents(input),
    index = parseRecoveryBundleIndex(decode(loaded[8].content!));
  [...names.map((name) => data[name]), index].forEach((payload, i) =>
    bytes(payload, ctx.descriptors[i]),
  );
  await requireRecoveryBundleCheckpoint(index, ctx.checkpoint, ctx.expected, data);
  const factory = async () => {
    const validation = await ctx.createValidationDatabase();
    if (validation === ctx.db)
      throw new StagedRecoveryBundleError("Bundle validation requires a separate empty database");
    return validation;
  };
  const cp = ctx.checkpoint.runAssetCheckpoint;
  await validateLocalRecoveryCheckpoint(
    factory,
    data.localSnapshot,
    cp.binding.localCheckpoint,
    ctx.expected,
  );
  await validateSharedRecoveryCheckpoint(
    factory,
    data.sharedHistory,
    cp.assetCheckpoint.binding.checkpoint,
    ctx.expected,
  );
  await validateSharedRecoveryRunArchive(
    factory,
    data.runArchive,
    cp.binding.checkpoint,
    ctx.expected,
    {
      actionArchive: data.actionArchive,
      originals: data.originalActions,
      executions: data.executions,
      sharedHistory: data.sharedHistory,
    },
  );
  await withTx(ctx.db, async (tx) => {
    await lockImageAssetWork(tx);
    await configureActionConnection((query) => tx.values(sql.raw(query)));
    await ready(tx, ctx, owner, index);
    const after = await readFiles(ctx, false);
    if (after.some((file, i) => !sameFile(file.identity!, loaded[i].identity!)))
      throw new StagedRecoveryBundleError("Staged bundle payload changed during validation");
    await ready(tx, ctx, owner, index);
  });
  return Object.freeze({ ...metadata, index, contents: data, owner });
}
