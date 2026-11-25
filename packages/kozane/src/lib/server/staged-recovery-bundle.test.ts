import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { migrateNodeDatabase } from "../../db/tx.js";
import { runArchiveAssetFixture } from "../../test-utils/run-archive-assets.js";
import { openDb } from "../../db/client.js";
import { localImageUploadTable } from "../../db/schema.js";
import { identity, filename } from "../../test-utils/retained-recovery-assets.js";
import { collectUnusedImages, storeImage } from "./image-assets.js";
import {
  releaseAssetManifest,
  inspectAssetManifest,
  reserveAssetManifest,
} from "../../db/api/asset-manifest.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { saveRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { saveRegisteredSharedRecoveryExecutionPayload } from "./shared-recovery-execution-payload.js";
import { saveRegisteredSharedRecoveryActionPayload } from "./shared-recovery-action-payload.js";
import { saveRegisteredSharedRecoveryRunArchivePayload } from "./shared-recovery-run-archive-payload.js";
import { saveRegisteredSharedRecoveryActionArchivePayload } from "./shared-recovery-action-archive-payload.js";
import { saveRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import * as files from "./run-archive-asset-payload.js";
import { saveRegisteredRecoveryBundle } from "./recovery-bundle.js";
import { installRegisteredRecoveryBundleImages } from "./recovery-image-installation.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("./run-archive-asset-payload.js", async (original) => ({
  ...(await original<typeof import("./run-archive-asset-payload.js")>()),
}));
vi.setConfig({ testTimeout: 30_000 });
let root: string,
  db: Awaited<ReturnType<typeof factory>>,
  source: Awaited<ReturnType<typeof runArchiveAssetFixture>>,
  assets: Awaited<ReturnType<typeof recovery.describeRunArchiveAssets>>;
let destination: Awaited<ReturnType<typeof factory>>;
let destinationRoot: string;
let bundle: Awaited<ReturnType<typeof recovery.describeRecoveryBundleIndex>>;
let uploads: (typeof localImageUploadTable.$inferSelect)[];
const stage = { kind: "transfer" as const, id: "stage" };
let mainDatabase: Awaited<ReturnType<typeof openDb>> | undefined;
const validationDatabases: Awaited<ReturnType<typeof openDb>>[] = [];
const factory = async () => {
  const opened = await openDb(":memory:");
  validationDatabases.push(opened);
  return opened.db;
};
function checkpoints() {
  const runs = assets.checkpoint.binding.checkpoint,
    archive = runs.checkpoint,
    originals = archive.checkpoint,
    executions = originals.checkpoint;
  return {
    assets: assets.checkpoint,
    runs,
    archive,
    originals,
    executions,
    shared: executions.checkpoint,
    local: assets.checkpoint.binding.localCheckpoint,
    current: assets.checkpoint.assetCheckpoint,
  };
}
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: checkpoints().local.byteLength,
  sharedMaxBytes: checkpoints().shared.byteLength,
  executionMaxBytes: checkpoints().executions.byteLength,
  actionMaxBytes: checkpoints().originals.byteLength,
  actionArchiveMaxBytes: checkpoints().archive.byteLength,
  runArchiveMaxBytes: checkpoints().runs.byteLength,
  assetMaxBytes: checkpoints().current.byteLength,
  runAssetMaxBytes: assets.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const bundleOptions = () => ({
  ...options(),
  checkpoint: bundle.checkpoint,
  maxBytes: bundle.checkpoint.byteLength,
});
const save = () => saveRegisteredRecoveryBundle({ ...bundleOptions(), input: bundle.index });
function contents() {
  return {
    localSnapshot: source.localSnapshot,
    sharedHistory: source.sharedHistory,
    executions: source.executions,
    originalActions: source.originalActions,
    actionArchive: source.actionArchive,
    runArchive: source.runArchive,
    currentAssets: source.currentAssets,
    runAssets: assets.payload,
  };
}
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-staged-bundle-"));
  mainDatabase = await openDb(`file:${join(root, "db.sqlite")}`);
  db = mainDatabase.db;
  await migrateNodeDatabase(db, { migrationsFolder: resolve("drizzle") });
  uploads = [];
  for (let n = 0; n < 32; n++) {
    const url = await storeImage(
      root,
      db,
      "image.svg",
      new TextEncoder().encode(`<svg><text>${n}</text></svg>`),
    );
    uploads.push(
      (await db.select().from(localImageUploadTable)).find(
        (row) => row.filename === url.split("/").pop(),
      )!,
    );
  }
  for (let n = 0; n < 32; n++)
    if (n !== 13)
      await db.run(
        sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${uploads[n].filename}`,
      );
  let json = JSON.stringify(await runArchiveAssetFixture());
  for (let n = 0; n < 32; n++) json = json.replaceAll(filename(n), uploads[n].filename);
  const f = JSON.parse(json);
  function walk(value: any) {
    if (!value || typeof value !== "object") return;
    if (typeof value.name === "string" && value.name.startsWith(".kozane/assets/images/")) {
      const upload = uploads.find((row) => value.name.endsWith(row.filename))!;
      value.byteLength = upload.byteLength;
      value.sha256 = upload.sha256;
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(f);
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','local/🪁'||char(0)||'file','workspace_relative',9007199254740993)`,
  );
  await db.run(
    sql`INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at) VALUES('pending','taskspace.directory',1,'absent','missing','local/layout','workspace_relative','pending','{}',9007199254740993)`,
  );
  const local = await recovery.captureLocalRecoveryCheckpoint(
    db,
    identity,
    async () => f.localSnapshot.selection,
  );
  const shared = await recovery.describeSharedRecoveryHistory(
    f.sharedHistory.history,
    identity,
    f.sharedHistory.selection,
  );
  const executions = await recovery.describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: f.executions.selection,
    effectSets: f.executions.effectSets,
  });
  const originals = await recovery.describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: f.originalActions.selection,
    actions: f.originalActions.actions,
  });
  for (const run of f.runArchive.effectSets) {
    const history = await recovery.describeSharedRecoveryHistory(
      run.history.history,
      identity,
      run.history.selection,
    );
    run.history = history.payload;
    run.executions = (
      await recovery.describeSharedRecoveryExecutions({
        checkpoint: history.checkpoint,
        sharedHistory: history.payload,
        selection: run.executions.selection,
        effectSets: run.executions.effectSets,
      })
    ).payload;
  }
  const archive = await recovery.describeSharedRecoveryActionArchive({
    checkpoint: originals.checkpoint,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: f.actionArchive.selection,
    actions: f.actionArchive.actions,
  });
  const runs = await recovery.describeSharedRecoveryRunArchive({
    checkpoint: archive.checkpoint,
    selection: f.runArchive.selection,
    effectSets: f.runArchive.effectSets,
    actionArchive: archive.payload,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
  const current = await recovery.describeRecoveryAssets({
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    history: f.currentAssets.history,
  });
  source = {
    binding: { checkpoint: runs.checkpoint, localCheckpoint: local.checkpoint },
    assetCheckpoint: current.checkpoint,
    history: f.history,
    originalImages: f.originalImages,
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    executions: executions.payload,
    originalActions: originals.payload,
    actionArchive: archive.payload,
    runArchive: runs.payload,
    currentAssets: current.payload,
  };
  assets = await recovery.describeRunArchiveAssets(source);
  await recovery.rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  await recovery.rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  await recovery.rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  await recovery.rememberSharedRecoveryActionArchiveCheckpoint(db, archive.checkpoint);
  await recovery.rememberSharedRecoveryRunArchiveCheckpoint(db, runs.checkpoint);
  await recovery.rememberRecoveryAssetCheckpoint(db, current.checkpoint);
  await recovery.rememberRunArchiveAssetCheckpoint(db, assets.checkpoint);
  const ctx = options();
  await saveRegisteredLocalRecoveryPayload({ ...ctx, input: local.snapshot });
  await saveRegisteredSharedRecoveryPayload({ ...ctx, input: shared.payload });
  await saveRegisteredSharedRecoveryExecutionPayload({ ...ctx, input: executions.payload });
  await saveRegisteredSharedRecoveryActionPayload({ ...ctx, input: originals.payload });
  await saveRegisteredSharedRecoveryActionArchivePayload({ ...ctx, input: archive.payload });
  await saveRegisteredSharedRecoveryRunArchivePayload({ ...ctx, input: runs.payload });
  await saveRegisteredRecoveryAssetPayload({
    root,
    db,
    expected: identity,
    localMaxBytes: ctx.localMaxBytes,
    sharedMaxBytes: ctx.sharedMaxBytes,
    createValidationDatabase: factory,
    input: current.payload,
  });
  await files.saveRegisteredRunArchiveAssetPayload({ ...ctx, input: assets.payload });
  await reserveAssetManifest(db, stage, assets.payload.manifest);
  bundle = await recovery.describeRecoveryBundleIndex(assets.checkpoint, contents());
  await save();
  const target = await openDb(`file:${join(root, "destination.sqlite")}`);
  validationDatabases.push(target);
  destination = target.db;
  destinationRoot = join(root, "receiving");
  await fs.mkdir(destinationRoot);
  await migrateNodeDatabase(destination, { migrationsFolder: resolve("drizzle") });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mainDatabase?.close();
  mainDatabase = undefined;
  for (const opened of validationDatabases.splice(0)) opened.close();
  await fs.rm(root, { recursive: true, force: true });
});

import {
  retainRegisteredRecoveryBundleInDestination,
  loadStagedRecoveryBundle,
} from "./staged-recovery-bundle.js";

const receiving = { ...identity, deviceId: "receiving-device" };
const imageOptions = (mode: "complete" | "shared-only" = "complete") => ({
  ...bundleOptions(),
  destination,
  destinationRoot,
  destinationExpected: mode === "complete" ? identity : receiving,
  mode,
});
async function stageDestination(mode: "complete" | "shared-only" = "complete") {
  const data = contents();
  if (mode === "complete") {
    await recovery.installLocalRecoverySnapshot(
      destination,
      factory,
      data.localSnapshot,
      bundle.checkpoint,
      identity,
    );
    await recovery.installSharedRecoverySnapshot(
      destination,
      factory,
      data.sharedHistory,
      bundle.checkpoint,
      identity,
    );
  } else
    await recovery.installSharedOnlyRecoverySnapshot(
      destination,
      factory,
      data.sharedHistory,
      bundle.checkpoint,
      identity,
      receiving,
    );
}

const destinationDirectory = () => join(destinationRoot, ".kozane", "recovery", "staged-bundles");
const payloadPath = (index: number) =>
  join(
    destinationDirectory(),
    (bundle.index.payloads[index] ?? bundle.checkpoint).sha256 + ".json",
  );
const temporaryPath = (index: number) =>
  join(
    destinationDirectory(),
    ".pending-" + (bundle.index.payloads[index] ?? bundle.checkpoint).sha256 + ".json",
  );
const loadOptions = (mode: "complete" | "shared-only" = "complete") => ({
  ...imageOptions(mode),
  db: destination,
  root: destinationRoot,
});
async function prepare(mode: "complete" | "shared-only" = "complete") {
  await stageDestination(mode);
  return installRegisteredRecoveryBundleImages(imageOptions(mode));
}
it("retains nine exact payloads and reopens complete history after the source becomes unavailable", async () => {
  const images = await prepare();
  const before = await recovery.captureLocalRecoverySnapshot(
    destination,
    identity,
    async () => source.localSnapshot.selection,
  );
  const retained = await retainRegisteredRecoveryBundleInDestination(imageOptions());
  expect(retained.copied).toBe(9);
  expect(retained.reused).toBe(0);
  expect(retained.changed).toBe(true);
  expect(retained.owner).toEqual(images.owner);
  expect(await fs.readdir(destinationDirectory())).toHaveLength(9);
  expect(
    await recovery.captureLocalRecoverySnapshot(
      destination,
      identity,
      async () => source.localSnapshot.selection,
    ),
  ).toEqual(before);
  mainDatabase!.close();
  mainDatabase = undefined;
  await fs.rename(join(root, ".kozane"), join(root, "source-offline"));
  const reopened = await loadStagedRecoveryBundle(loadOptions());
  expect(reopened.index).toEqual(bundle.index);
  expect(reopened.contents).toEqual(contents());
  expect(Object.isFrozen(reopened.contents)).toBe(true);
  expect((await inspectAssetManifest(destination, images.owner)).record.state).toBe("retained");
});
it("retains shared-only artifacts without installing source local rows or catalog authority", async () => {
  await prepare("shared-only");
  const before = await recovery.captureLocalRecoverySnapshot(
    destination,
    receiving,
    async () => source.localSnapshot.selection,
  );
  await retainRegisteredRecoveryBundleInDestination(imageOptions("shared-only"));
  const reopened = await loadStagedRecoveryBundle(loadOptions("shared-only"));
  expect(reopened.destinationIdentity).toEqual(receiving);
  expect(reopened.contents).toEqual(contents());
  expect(
    await recovery.captureLocalRecoverySnapshot(
      destination,
      receiving,
      async () => source.localSnapshot.selection,
    ),
  ).toEqual(before);
  expect(
    await destination.values(
      sql`SELECT 1 FROM taskspace_local UNION ALL SELECT 1 FROM local_file_operation UNION ALL SELECT 1 FROM local_recovery_checkpoint`,
    ),
  ).toEqual([]);
});
it("reuses verified payloads on retry without changing file identities or destination rows", async () => {
  await prepare();
  await retainRegisteredRecoveryBundleInDestination(imageOptions());
  const before = await Promise.all(
    Array.from({ length: 9 }, (_, i) => fs.stat(payloadPath(i), { bigint: true })),
  );
  await destination.run(
    sql`INSERT INTO taskspace_local VALUES('later','later','workspace_relative',1)`,
  );
  const retry = await retainRegisteredRecoveryBundleInDestination(imageOptions());
  expect(retry).toMatchObject({ copied: 0, reused: 9, changed: false });
  const after = await Promise.all(
    Array.from({ length: 9 }, (_, i) => fs.stat(payloadPath(i), { bigint: true })),
  );
  expect(after.map((x) => [x.ino, x.mtimeNs])).toEqual(before.map((x) => [x.ino, x.mtimeNs]));
  await loadStagedRecoveryBundle(loadOptions());
  expect(
    (
      await destination.values(sql`SELECT path FROM taskspace_local WHERE taskspace_id='later'`)
    )[0][0],
  ).toBe("later");
});
it("requires matching staging and retained image protection before creating destination artifacts", async () => {
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow();
  await stageDestination();
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow(
    "owner not found",
  );
  await expect(fs.lstat(destinationDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  const images = await installRegisteredRecoveryBundleImages(imageOptions());
  await releaseAssetManifest(destination, images.owner, "Reviewed");
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow(
    "not retained",
  );
  await expect(fs.lstat(destinationDirectory())).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses each invalid read limit and mismatched identity before file reads or SQL allocation", async () => {
  const factorySpy = vi.fn(factory),
    open = vi.spyOn(fs, "open");
  const ctx = { ...loadOptions(), createValidationDatabase: factorySpy };
  for (const name of [
    "maxBytes",
    "localMaxBytes",
    "sharedMaxBytes",
    "executionMaxBytes",
    "actionMaxBytes",
    "actionArchiveMaxBytes",
    "runArchiveMaxBytes",
    "assetMaxBytes",
    "runAssetMaxBytes",
  ]) {
    await expect(loadStagedRecoveryBundle({ ...ctx, [name]: 0 })).rejects.toThrow(
      "positive safe integers",
    );
    await expect(loadStagedRecoveryBundle({ ...ctx, [name]: 1 })).rejects.toThrow(
      "exceeds read limit",
    );
  }
  await expect(
    loadStagedRecoveryBundle({ ...ctx, expected: { ...identity, deviceId: "wrong" } }),
  ).rejects.toThrow("source identity");
  await expect(loadStagedRecoveryBundle({ ...ctx, mode: "automatic" as any })).rejects.toThrow(
    "explicit",
  );
  expect(open).not.toHaveBeenCalled();
  expect(factorySpy).not.toHaveBeenCalled();
});
it("refuses every missing or corrupt payload and retained temporary evidence before SQL allocation", async () => {
  await prepare();
  await retainRegisteredRecoveryBundleInDestination(imageOptions());
  const factorySpy = vi.fn(factory);
  for (let i = 0; i < 9; i++) {
    const path = payloadPath(i),
      saved = await fs.readFile(path);
    await fs.unlink(path);
    await expect(
      loadStagedRecoveryBundle({ ...loadOptions(), createValidationDatabase: factorySpy }),
    ).rejects.toThrow("absent");
    await fs.writeFile(path, "changed");
    await expect(
      loadStagedRecoveryBundle({ ...loadOptions(), createValidationDatabase: factorySpy }),
    ).rejects.toThrow("different-content");
    await fs.writeFile(path, saved);
    await fs.writeFile(temporaryPath(i), saved);
    await expect(
      loadStagedRecoveryBundle({ ...loadOptions(), createValidationDatabase: factorySpy }),
    ).rejects.toThrow("Temporary");
    await fs.unlink(temporaryPath(i));
  }
  expect(factorySpy).not.toHaveBeenCalled();
  await fs.unlink(payloadPath(0));
  await fs.symlink(payloadPath(1), payloadPath(0));
  await expect(loadStagedRecoveryBundle(loadOptions())).rejects.toThrow("unsafe-path");
});
it("preserves conflicting payloads and publishes the index only after every required payload", async () => {
  await prepare();
  await fs.mkdir(destinationDirectory(), { recursive: true });
  await fs.writeFile(payloadPath(7), "conflict");
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow(
    "publication failed",
  );
  expect(await fs.readFile(payloadPath(7), "utf8")).toBe("conflict");
  await expect(fs.lstat(payloadPath(8))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readdir(destinationDirectory())).toHaveLength(8);
  await fs.unlink(payloadPath(7));
  const retry = await retainRegisteredRecoveryBundleInDestination(imageOptions());
  expect(retry).toMatchObject({ copied: 2, reused: 7, changed: true });
  await loadStagedRecoveryBundle(loadOptions());
});
it("preserves temporary publication evidence and never accepts a matching final beside it", async () => {
  await prepare();
  const original = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
    if (String(path) === temporaryPath(0)) throw Error("Interrupted unlink");
    return original(path);
  });
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow(
    "publication failed",
  );
  expect((await fs.lstat(payloadPath(0))).isFile()).toBe(true);
  expect((await fs.lstat(temporaryPath(0))).isFile()).toBe(true);
  vi.restoreAllMocks();
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow(
    "publication failed",
  );
  await expect(loadStagedRecoveryBundle(loadOptions())).rejects.toThrow("Temporary");
});
it("rejects failed destination commits while preserving retained pins and reusable artifacts", async () => {
  const images = await prepare("shared-only");
  const wrapped = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        await work(tx);
        throw Error("Commit failed");
      }),
  });
  await expect(
    retainRegisteredRecoveryBundleInDestination({
      ...imageOptions("shared-only"),
      destination: wrapped,
    }),
  ).rejects.toThrow("Commit failed");
  expect(await fs.readdir(destinationDirectory())).toHaveLength(9);
  expect((await inspectAssetManifest(destination, images.owner)).record.state).toBe("retained");
  await collectUnusedImages(destinationRoot, destination, Date.now() + 3 * 86400000);
  expect(
    (await retainRegisteredRecoveryBundleInDestination(imageOptions("shared-only"))).changed,
  ).toBe(false);
  await expect(
    loadStagedRecoveryBundle({ ...loadOptions("shared-only"), db: wrapped }),
  ).rejects.toThrow("Commit failed");
  let writes = 0;
  const finalFailure = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        const result = await work(tx);
        if (++writes === 2) throw Error("Final verification commit failed");
        return result;
      }),
  });
  await expect(
    loadStagedRecoveryBundle({ ...loadOptions("shared-only"), db: finalFailure }),
  ).rejects.toThrow("Final verification commit failed");
  expect(writes).toBe(2);
});
it("refuses changed file identities, released pins and damaged images after isolated validation", async () => {
  const images = await prepare();
  await retainRegisteredRecoveryBundleInDestination(imageOptions());
  let changed = false;
  const changing = async () => {
    if (!changed) {
      changed = true;
      const data = await fs.readFile(payloadPath(0));
      await fs.unlink(payloadPath(0));
      await fs.writeFile(payloadPath(0), data);
    }
    return factory();
  };
  await expect(
    loadStagedRecoveryBundle({ ...loadOptions(), createValidationDatabase: changing }),
  ).rejects.toThrow("changed during validation");
  const image = join(destinationRoot, bundle.index.manifest.entries[0].name),
    original = await fs.readFile(image);
  await fs.writeFile(image, "damaged");
  await expect(loadStagedRecoveryBundle(loadOptions())).rejects.toThrow("Required image");
  await fs.writeFile(image, original);
  await releaseAssetManifest(destination, images.owner, "Reviewed");
  await expect(loadStagedRecoveryBundle(loadOptions())).rejects.toThrow("not retained");
});
it("owns caller inputs before source and destination validation callbacks yield", async () => {
  await prepare();
  const opts = {
    ...imageOptions(),
    expected: { ...identity },
    destinationExpected: { ...identity },
    checkpoint: structuredClone(bundle.checkpoint) as any,
  };
  opts.createValidationDatabase = async () => {
    opts.root = "invalid";
    opts.destinationRoot = "invalid";
    opts.expected.deviceId = "wrong";
    opts.destinationExpected.deviceId = "wrong";
    opts.checkpoint.sha256 = "a".repeat(64);
    opts.maxBytes = 0;
    opts.destination = db;
    return factory();
  };
  expect((await retainRegisteredRecoveryBundleInDestination(opts)).copied).toBe(9);
  const input = {
    ...loadOptions(),
    expected: { ...identity },
    destinationExpected: { ...identity },
    checkpoint: structuredClone(bundle.checkpoint) as any,
  };
  input.createValidationDatabase = async () => {
    input.root = "invalid";
    input.db = db;
    input.expected.deviceId = "wrong";
    input.destinationExpected.deviceId = "wrong";
    input.checkpoint.sha256 = "b".repeat(64);
    input.maxBytes = 0;
    return factory();
  };
  expect((await loadStagedRecoveryBundle(input)).index).toEqual(bundle.index);
});
it("refuses workspace aliases and validation factories that return either live database", async () => {
  await prepare();
  await expect(
    retainRegisteredRecoveryBundleInDestination({ ...imageOptions(), destination: db }),
  ).rejects.toThrow("separate");
  await expect(
    retainRegisteredRecoveryBundleInDestination({ ...imageOptions(), destinationRoot: root }),
  ).rejects.toThrow("separate");
  await expect(
    retainRegisteredRecoveryBundleInDestination({
      ...imageOptions(),
      createValidationDatabase: async () => destination,
    }),
  ).rejects.toThrow("separate empty");
  await expect(fs.lstat(destinationDirectory())).rejects.toMatchObject({ code: "ENOENT" });
  await fs.mkdir(join(destinationRoot, ".kozane", "recovery"));
  await fs.symlink(join(root, ".kozane", "recovery", "bundle-indexes"), destinationDirectory());
  await expect(retainRegisteredRecoveryBundleInDestination(imageOptions())).rejects.toThrow(
    "publication failed",
  );
  expect((await fs.lstat(destinationDirectory())).isSymbolicLink()).toBe(true);
  await fs.unlink(destinationDirectory());
  await retainRegisteredRecoveryBundleInDestination(imageOptions());
  await expect(
    loadStagedRecoveryBundle({
      ...loadOptions(),
      createValidationDatabase: async () => destination,
    }),
  ).rejects.toThrow("separate empty");
});
it("refuses protection released by another connection during SQL validation", async () => {
  const images = await prepare();
  await retainRegisteredRecoveryBundleInDestination(imageOptions());
  const second = await openDb(`file:${join(root, "destination.sqlite")}`);
  validationDatabases.push(second);
  let released = false;
  await expect(
    loadStagedRecoveryBundle({
      ...loadOptions(),
      createValidationDatabase: async () => {
        if (!released) {
          released = true;
          await releaseAssetManifest(second.db, images.owner, "Reviewed concurrently");
        }
        return factory();
      },
    }),
  ).rejects.toThrow("not retained");
  expect((await inspectAssetManifest(destination, images.owner)).record.state).toBe("released");
});
it("serializes artifact publication with competing cleanup and owner release", async () => {
  const images = await prepare("shared-only");
  const second = await openDb(`file:${join(root, "destination.sqlite")}`);
  validationDatabases.push(second);
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const wrapped = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        const result = await work(tx);
        entered.resolve();
        await proceed.promise;
        return result;
      }),
  });
  const pending = retainRegisteredRecoveryBundleInDestination({
    ...imageOptions("shared-only"),
    destination: wrapped,
  });
  const settled = pending.then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  try {
    await Promise.race([
      entered.promise,
      settled.then((value) => {
        throw value.error ?? Error("Did not reach publication transaction");
      }),
    ]);
    expect(await fs.readdir(destinationDirectory())).toHaveLength(9);
    await second.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(
      releaseAssetManifest(second.db, images.owner, "Concurrent release"),
    ).rejects.toThrow();
    await expect(
      collectUnusedImages(destinationRoot, second.db, Date.now() + 3 * 86400000),
    ).rejects.toThrow();
    proceed.resolve();
    expect((await settled).error).toBeNull();
    expect((await inspectAssetManifest(second.db, images.owner)).record.state).toBe("retained");
    await loadStagedRecoveryBundle(loadOptions("shared-only"));
  } finally {
    proceed.resolve();
    await settled;
  }
});
