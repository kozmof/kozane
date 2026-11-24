import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
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
import { storeImage, imageDirectory } from "./image-assets.js";
import { inspectAssetManifest, reserveAssetManifest } from "../../db/api/asset-manifest.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { saveRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { saveRegisteredSharedRecoveryExecutionPayload } from "./shared-recovery-execution-payload.js";
import { saveRegisteredSharedRecoveryActionPayload } from "./shared-recovery-action-payload.js";
import { saveRegisteredSharedRecoveryRunArchivePayload } from "./shared-recovery-run-archive-payload.js";
import { saveRegisteredSharedRecoveryActionArchivePayload } from "./shared-recovery-action-archive-payload.js";
import { saveRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import * as files from "./run-archive-asset-payload.js";
import { saveRegisteredRecoveryBundle, loadRegisteredRecoveryBundle } from "./recovery-bundle.js";
import {
  installRegisteredRecoveryBundleLocalSnapshot,
  installRegisteredRecoveryBundleSharedSnapshot,
} from "./recovery-bundle-installation.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("./run-archive-asset-payload.js", async (original) => ({
  ...(await original<typeof import("./run-archive-asset-payload.js")>()),
}));
let root: string,
  db: Awaited<ReturnType<typeof factory>>,
  source: Awaited<ReturnType<typeof runArchiveAssetFixture>>,
  assets: Awaited<ReturnType<typeof recovery.describeRunArchiveAssets>>;
let destination: Awaited<ReturnType<typeof factory>>;
let bundle: Awaited<ReturnType<typeof recovery.describeRecoveryBundleIndex>>;
let uploads: (typeof localImageUploadTable.$inferSelect)[];
const stage = { kind: "transfer" as const, id: "stage" };
const owner = () => registeredLocalRecoveryImageOwner(identity);
let mainDatabase: Awaited<ReturnType<typeof openDb>> | undefined;
const validationDatabases: Awaited<ReturnType<typeof openDb>>[] = [];
const factory = async () => {
  const opened = await openDb(":memory:");
  validationDatabases.push(opened);
  return opened.db;
};
const file = (n: number) => join(imageDirectory(root), uploads[n].filename);
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
const tables = {
  assets: "local_recovery_run_assets",
  runs: "local_recovery_run_archives",
  archive: "local_recovery_action_archives",
  originals: "local_recovery_actions",
  executions: "local_recovery_executions",
  shared: "local_recovery_shared_history",
  local: "local_recovery_checkpoint",
  current: "local_recovery_assets",
} as const;
type Name = keyof typeof tables;
const area = (name: Name) =>
  ({
    assets: "run-asset-manifests",
    runs: "run-archives",
    archive: "action-archives",
    originals: "actions",
    executions: "executions",
    shared: "shared-history",
    local: "checkpoints",
    current: "asset-manifests",
  })[name];
const path = (name: Name) =>
  join(root, ".kozane", "recovery", area(name), `${checkpoints()[name].sha256}.json`);
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
const load = () => loadRegisteredRecoveryBundle(bundleOptions());
const inspectOwner = () => inspectAssetManifest(db, owner());
const directory = () => join(root, ".kozane", "recovery", "bundle-indexes");
const published = () => join(directory(), bundle.checkpoint.sha256 + ".json");
const pending = () => join(directory(), ".pending-" + bundle.checkpoint.sha256 + ".json");
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
const catalogs = () =>
  Promise.all(
    Object.values(tables).map((table) =>
      db.values(sql.raw("SELECT descriptor,CAST(created_at AS TEXT) FROM " + table)),
    ),
  );
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-bundle-publication-"));
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

const install = () =>
  installRegisteredRecoveryBundleLocalSnapshot({ ...bundleOptions(), destination });
it("installs exact local data once from a validated published bundle without filesystem operations", async () => {
  const before = await catalogs(),
    protectedOwner = (await inspectOwner()).record,
    mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  expect(await install()).toEqual({ checkpoint: bundle.checkpoint, changed: true });
  expect(
    await recovery.captureLocalRecoverySnapshot(
      destination,
      identity,
      async () => source.localSnapshot.selection,
    ),
  ).toEqual(source.localSnapshot);
  expect(await recovery.inspectLocalRecoveryInstallation(destination)).toEqual(bundle.checkpoint);
  expect(await destination.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
  expect(await catalogs()).toEqual(before);
  expect((await inspectOwner()).record).toEqual(protectedOwner);
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" && (call[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
  expect(
    await destination.get(sql`SELECT state FROM local_file_operation WHERE id='pending'`),
  ).toMatchObject({ state: "pending" });
});
it("acknowledges later retries after local edits without reopening unavailable bundle files", async () => {
  await install();
  await destination.run(sql`UPDATE taskspace_local SET path='later edit'`);
  await fs.unlink(published());
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  expect(
    await installRegisteredRecoveryBundleLocalSnapshot({
      ...bundleOptions(),
      destination,
      createValidationDatabase: create,
    }),
  ).toEqual({ checkpoint: bundle.checkpoint, changed: false });
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(await destination.get(sql`SELECT path FROM taskspace_local`)).toMatchObject({
    path: "later edit",
  });
  await expect(load()).rejects.toThrow();
});
it.each(["missing-index", "temporary-index", "missing-local", "missing-image", "released-owner"])(
  "refuses %s before changing a fresh destination",
  async (defect) => {
    if (defect === "missing-index") await fs.unlink(published());
    if (defect === "temporary-index") await fs.rename(published(), pending());
    if (defect === "missing-local") await fs.unlink(path("local"));
    if (defect === "missing-image") await fs.unlink(file(31));
    if (defect === "released-owner") {
      const { releaseAssetManifest } = await import("../../db/api/asset-manifest.js");
      await releaseAssetManifest(db, owner(), "Retired");
    }
    await expect(install()).rejects.toThrow();
    expect(await recovery.inspectLocalRecoveryInstallation(destination)).toBeNull();
    expect(await destination.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
  },
);
it.each(["deviceId", "workspaceId", "epochId", "checkpointId"] as const)(
  "refuses a different destination %s before file reads",
  async (field) => {
    const open = vi.spyOn(fs, "open");
    await expect(
      installRegisteredRecoveryBundleLocalSnapshot({
        ...bundleOptions(),
        destination,
        expected: { ...identity, [field]: "other" },
      }),
    ).rejects.toThrow("identity mismatch");
    expect(open).not.toHaveBeenCalled();
    expect(await recovery.inspectLocalRecoveryInstallation(destination)).toBeNull();
  },
);
it.each(["source", "populated-target"])(
  "refuses the %s database before opening bundle files",
  async (which) => {
    if (which === "populated-target")
      await destination.run(
        sql`INSERT INTO taskspace_local VALUES('keep','Keep','workspace_relative',0)`,
      );
    const open = vi.spyOn(fs, "open");
    await expect(
      installRegisteredRecoveryBundleLocalSnapshot({
        ...bundleOptions(),
        destination: which === "source" ? db : destination,
      }),
    ).rejects.toThrow("empty destination");
    expect(open).not.toHaveBeenCalled();
  },
);
it("rejects another bundle after local installation before reading source files", async () => {
  await install();
  const open = vi.spyOn(fs, "open"),
    checkpoint = { ...bundle.checkpoint, sha256: "b".repeat(64) };
  await expect(
    installRegisteredRecoveryBundleLocalSnapshot({ ...bundleOptions(), destination, checkpoint }),
  ).rejects.toThrow("different local installation");
  expect(open).not.toHaveBeenCalled();
  expect(await recovery.inspectLocalRecoveryInstallation(destination)).toEqual(bundle.checkpoint);
});
it("rolls back the destination after its commit fails while preserving the source bundle and pins", async () => {
  const before = await catalogs(),
    protectedOwner = (await inspectOwner()).record;
  const wrapped = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        const result = await work(tx);
        await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
        await tx.run(
          sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
        );
        await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
        return result;
      }),
  });
  await expect(
    installRegisteredRecoveryBundleLocalSnapshot({ ...bundleOptions(), destination: wrapped }),
  ).rejects.toThrow();
  expect(await recovery.inspectLocalRecoveryInstallation(destination)).toBeNull();
  expect(await destination.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
  expect(await catalogs()).toEqual(before);
  expect((await inspectOwner()).record).toEqual(protectedOwner);
  expect((await install()).changed).toBe(true);
});
it("owns destination, identity, descriptor and source limits before validation callbacks", async () => {
  const input = {
    ...bundleOptions(),
    destination,
    expected: { ...identity },
    checkpoint: JSON.parse(JSON.stringify(bundle.checkpoint)),
  };
  input.createValidationDatabase = async () => {
    input.destination = db;
    input.root = join(root, "elsewhere");
    input.expected.deviceId = "changed";
    input.checkpoint.sha256 = "b".repeat(64);
    for (const field of [
      "maxBytes",
      "localMaxBytes",
      "sharedMaxBytes",
      "executionMaxBytes",
      "actionMaxBytes",
      "actionArchiveMaxBytes",
      "runArchiveMaxBytes",
      "assetMaxBytes",
      "runAssetMaxBytes",
    ])
      (input as any)[field] = 0;
    return factory();
  };
  expect((await installRegisteredRecoveryBundleLocalSnapshot(input)).changed).toBe(true);
  expect(await recovery.inspectLocalRecoveryInstallation(destination)).toEqual(bundle.checkpoint);
  expect(await recovery.inspectLocalRecoveryInstallation(db)).toBeNull();
});

const installShared = () =>
  installRegisteredRecoveryBundleSharedSnapshot({ ...bundleOptions(), destination });
it("stages shared rows from a complete published bundle after matching local installation", async () => {
  await install();
  await destination.run(sql`UPDATE taskspace_local SET path='Local edit'`);
  const before = await recovery.captureLocalRecoverySnapshot(
      destination,
      identity,
      async () => source.localSnapshot.selection,
    ),
    catalogsBefore = await catalogs(),
    ownerBefore = (await inspectOwner()).record;
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink");
  expect(await installShared()).toEqual({ checkpoint: bundle.checkpoint, changed: true });
  expect(await recovery.inspectSharedRecoveryInstallation(destination)).toEqual(bundle.checkpoint);
  expect(
    await recovery.captureLocalRecoverySnapshot(
      destination,
      identity,
      async () => source.localSnapshot.selection,
    ),
  ).toEqual(before);
  expect(await catalogs()).toEqual(catalogsBefore);
  expect((await inspectOwner()).record).toEqual(ownerBefore);
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
});
it("requires matching local staging before reopening source files for shared installation", async () => {
  const open = vi.spyOn(fs, "open");
  await expect(installShared()).rejects.toThrow("matching local installation");
  expect(open).not.toHaveBeenCalled();
  expect(await recovery.inspectSharedRecoveryInstallation(destination)).toBeNull();
});
it("acknowledges shared retries without files or validation and preserves later edits", async () => {
  await install();
  await installShared();
  await destination.run(sql`INSERT INTO namespace VALUES('later','Keep',0)`);
  await destination.run(sql`UPDATE taskspace_local SET path='Keep local'`);
  await fs.unlink(published());
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  expect(
    await installRegisteredRecoveryBundleSharedSnapshot({
      ...bundleOptions(),
      destination,
      createValidationDatabase: create,
    }),
  ).toEqual({ checkpoint: bundle.checkpoint, changed: false });
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(await destination.get(sql`SELECT name FROM namespace`)).toMatchObject({ name: "Keep" });
  expect(await destination.get(sql`SELECT path FROM taskspace_local`)).toMatchObject({
    path: "Keep local",
  });
});
it.each(["missing-index", "missing-shared", "missing-image", "released-owner"])(
  "refuses %s before shared staging and preserves installed local rows",
  async (defect) => {
    await install();
    const before = await recovery.captureLocalRecoverySnapshot(
      destination,
      identity,
      async () => source.localSnapshot.selection,
    );
    if (defect === "missing-index") await fs.unlink(published());
    if (defect === "missing-shared") await fs.unlink(path("shared"));
    if (defect === "missing-image") await fs.unlink(file(31));
    if (defect === "released-owner") {
      const { releaseAssetManifest } = await import("../../db/api/asset-manifest.js");
      await releaseAssetManifest(db, owner(), "Retired");
    }
    await expect(installShared()).rejects.toThrow();
    expect(await recovery.inspectSharedRecoveryInstallation(destination)).toBeNull();
    expect(
      await recovery.captureLocalRecoverySnapshot(
        destination,
        identity,
        async () => source.localSnapshot.selection,
      ),
    ).toEqual(before);
  },
);
it("refuses conflicting or populated shared staging before reopening source files", async () => {
  await install();
  const open = vi.spyOn(fs, "open");
  await expect(
    installRegisteredRecoveryBundleSharedSnapshot({
      ...bundleOptions(),
      destination,
      checkpoint: { ...bundle.checkpoint, sha256: "b".repeat(64) },
    }),
  ).rejects.toThrow("matching local installation");
  await destination.run(sql`INSERT INTO namespace VALUES('populated','Keep',0)`);
  await expect(installShared()).rejects.toThrow("empty shared tables");
  expect(open).not.toHaveBeenCalled();
});
