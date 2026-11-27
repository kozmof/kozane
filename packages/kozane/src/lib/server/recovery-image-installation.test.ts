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
import { collectUnusedImages, storeImage, imageDirectory } from "./image-assets.js";
import {
  releaseAssetManifest,
  inspectAssetManifest,
  reserveAssetManifest,
} from "../../db/api/asset-manifest.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { saveRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { saveRegisteredSharedRecoveryExecutionPayload } from "./shared-recovery-execution-payload.js";
import { saveRegisteredSharedRecoveryActionPayload } from "./shared-recovery-action-payload.js";
import { saveRegisteredSharedRecoveryRunArchivePayload } from "./shared-recovery-run-archive-payload.js";
import { saveRegisteredSharedRecoveryActionArchivePayload } from "./shared-recovery-action-archive-payload.js";
import { saveRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import * as files from "./run-archive-asset-payload.js";
import { saveRegisteredRecoveryBundle } from "./recovery-bundle.js";
import {
  installRegisteredRecoveryBundleImages,
  registeredRecoveryDestinationImageOwner,
} from "./recovery-image-installation.js";
import { recoveryImageTemporaryName } from "./recovery-image-files.js";
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
const inspectOwner = () => inspectAssetManifest(db, owner());
const directory = () => join(root, ".kozane", "recovery", "bundle-indexes");
const published = () => join(directory(), bundle.checkpoint.sha256 + ".json");
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

const requiredIndex = (index: number) =>
  uploads.findIndex(
    (upload) =>
      ".kozane/assets/images/" + upload.filename === bundle.index.manifest.entries.at(index)!.name,
  );
const imageCount = () => bundle.index.manifest.entries.length;
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
const target = (n: number) => join(imageDirectory(destinationRoot), uploads[n].filename);
const temporary = (n: number) =>
  join(
    imageDirectory(destinationRoot),
    recoveryImageTemporaryName(bundle.checkpoint.sha256, uploads[n].filename),
  );
async function destinationOwner(mode: "complete" | "shared-only" = "complete") {
  return registeredRecoveryDestinationImageOwner(
    await recovery.inspectRecoveryStagingDestination(
      destination,
      bundle.checkpoint,
      identity,
      mode === "complete" ? identity : receiving,
      mode,
    ),
  );
}
it("copies all protected images under their immutable names after complete staging and preserves all source records", async () => {
  await stageDestination();
  const before = await catalogs(),
    sourceOwner = (await inspectOwner()).record;
  const beforeLocal = await recovery.captureLocalRecoverySnapshot(
    destination,
    identity,
    async () => source.localSnapshot.selection,
  );
  const result = await installRegisteredRecoveryBundleImages(imageOptions());
  expect(result.copied).toBe(imageCount());
  expect(result.reused).toBe(0);
  expect(result.changed).toBe(true);
  expect(result.mode).toBe("complete");
  expect((await inspectAssetManifest(destination, result.owner)).record.state).toBe("retained");
  for (const image of result.manifest.entries) {
    const name = image.name.slice(".kozane/assets/images/".length);
    expect(await fs.readFile(join(imageDirectory(destinationRoot), name))).toEqual(
      await fs.readFile(join(imageDirectory(root), name)),
    );
  }
  const after = await recovery.captureLocalRecoverySnapshot(
    destination,
    identity,
    async () => source.localSnapshot.selection,
  );
  for (const table of beforeLocal.tables) {
    const actual = after.tables.find((t) => t.name === table.name)!;
    expect(
      actual.rows.filter(
        (row) => table.name !== "local_asset_manifest" || row.owner_id[1] !== result.owner.id,
      ),
    ).toEqual(table.rows);
  }
  expect(await catalogs()).toEqual(before);
  expect((await inspectOwner()).record).toEqual(sourceOwner);
  expect(await fs.readdir(destinationRoot)).toEqual([".kozane"]);
});
it("copies images for shared-only recovery without creating source paths, uploads or pending file work", async () => {
  await stageDestination("shared-only");
  const result = await installRegisteredRecoveryBundleImages(imageOptions("shared-only"));
  expect(result.copied).toBe(imageCount());
  expect(result.destinationIdentity).toEqual(receiving);
  const snapshot = await recovery.captureLocalRecoverySnapshot(
    destination,
    receiving,
    async () => source.localSnapshot.selection,
  );
  expect(
    snapshot.tables
      .filter((t) => t.name !== "local_asset_manifest")
      .every((t) => t.rows.length === 0),
  ).toBe(true);
  expect(snapshot.tables.find((t) => t.name === "local_asset_manifest")!.rows).toHaveLength(1);
  expect(await recovery.inspectLocalRecoveryInstallation(destination)).toBeNull();
});
it("reuses verified final files on explicit retry and rechecks physical bytes", async () => {
  await stageDestination();
  const first = await installRegisteredRecoveryBundleImages(imageOptions()),
    before = await fs.stat(target(0), { bigint: true });
  const link = vi.spyOn(fs, "link"),
    write = vi.spyOn(fs, "writeFile");
  const retry = await installRegisteredRecoveryBundleImages(imageOptions());
  expect(retry.copied).toBe(0);
  expect(retry.reused).toBe(imageCount());
  expect(retry.changed).toBe(false);
  expect(retry.owner).toEqual(first.owner);
  expect((await fs.stat(target(0), { bigint: true })).ino).toBe(before.ino);
  expect(link).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  await fs.writeFile(target(0), "corrupt");
  await expect(installRegisteredRecoveryBundleImages(imageOptions())).rejects.toThrow(
    "Existing destination image",
  );
  expect(await fs.readFile(target(0), "utf8")).toBe("corrupt");
});
it("requires complete destination staging before reading source files or reserving pins", async () => {
  const open = vi.spyOn(fs, "open");
  await expect(installRegisteredRecoveryBundleImages(imageOptions())).rejects.toThrow(
    "matching local and shared installations",
  );
  expect(open).not.toHaveBeenCalled();
  await expect(destination.values(sql`SELECT 1 FROM local_asset_manifest`)).resolves.toEqual([]);
});
it("requires independently trusted identities and an explicit mode before reading source files", async () => {
  await stageDestination();
  const open = vi.spyOn(fs, "open");
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions(), destinationExpected: receiving }),
  ).rejects.toThrow("originating device");
  await expect(
    installRegisteredRecoveryBundleImages({
      ...imageOptions(),
      expected: { ...identity, deviceId: "other" },
    }),
  ).rejects.toThrow("source identity mismatch");
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions(), mode: "shared-only" }),
  ).rejects.toThrow("mode conflicts");
  expect(open).not.toHaveBeenCalled();
});
it("refuses shared-only staging for another receiving identity", async () => {
  await stageDestination("shared-only");
  await expect(
    installRegisteredRecoveryBundleImages({
      ...imageOptions("shared-only"),
      destinationExpected: { ...receiving, deviceId: "other" },
    }),
  ).rejects.toThrow("matching shared-only installation");
});
it("refuses source/destination aliases and invalid limits before destination file publication", async () => {
  await stageDestination();
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions(), destination: db }),
  ).rejects.toThrow("separate destination database");
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions(), destinationRoot: root }),
  ).rejects.toThrow("roots must be separate");
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions(), maxBytes: 0 }),
  ).rejects.toThrow("positive safe integers");
  expect(await fs.readdir(destinationRoot)).toEqual([]);
});
it.each(["missing-index", "missing-image", "released-source"])(
  "refuses %s without reserving destination protection",
  async (defect) => {
    await stageDestination("shared-only");
    if (defect === "missing-index") await fs.unlink(published());
    if (defect === "missing-image") await fs.unlink(file(31));
    if (defect === "released-source") await releaseAssetManifest(db, owner(), "Retired");
    await expect(
      installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
    ).rejects.toThrow();
    expect(await destination.values(sql`SELECT 1 FROM local_asset_manifest`)).toEqual([]);
    expect(await fs.readdir(destinationRoot)).toEqual([]);
  },
);
it.each(["corrupt", "symlink", "temporary", "upload-temporary"])(
  "refuses %s destination evidence while keeping its pending pin and bytes",
  async (defect) => {
    await stageDestination("shared-only");
    const first = requiredIndex(0);
    await fs.mkdir(imageDirectory(destinationRoot), { recursive: true });
    if (defect === "corrupt") await fs.writeFile(target(first), "different");
    if (defect === "symlink") await fs.symlink(file(first), target(first));
    if (defect === "temporary") await fs.copyFile(file(first), temporary(first));
    if (defect === "upload-temporary")
      await fs.copyFile(
        file(first),
        join(imageDirectory(destinationRoot), `.upload-${uploads[first].filename}`),
      );
    const before = await fs.readdir(imageDirectory(destinationRoot));
    await expect(
      installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
    ).rejects.toThrow();
    expect(
      (await inspectAssetManifest(destination, await destinationOwner("shared-only"))).record.state,
    ).toBe("pending");
    expect(await fs.readdir(imageDirectory(destinationRoot))).toEqual(before);
  },
);
it("refuses unsafe destination directory components without writing through the link", async () => {
  await stageDestination("shared-only");
  const outside = join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, join(destinationRoot, ".kozane"));
  await expect(installRegisteredRecoveryBundleImages(imageOptions("shared-only"))).rejects.toThrow(
    "unsafe",
  );
  expect(await fs.readdir(outside)).toEqual([]);
  expect(
    (await inspectAssetManifest(destination, await destinationOwner("shared-only"))).record.state,
  ).toBe("pending");
});
it("reads verified archived source bytes and reuses a matching destination archive", async () => {
  await stageDestination("shared-only");
  const first = requiredIndex(0),
    last = requiredIndex(-1);
  await fs.mkdir(join(imageDirectory(root), ".retained"));
  await fs.rename(file(last), join(imageDirectory(root), ".retained", uploads[last].filename));
  await fs.mkdir(join(imageDirectory(destinationRoot), ".retained"), { recursive: true });
  await fs.copyFile(
    file(first),
    join(imageDirectory(destinationRoot), ".retained", uploads[first].filename),
  );
  const result = await installRegisteredRecoveryBundleImages(imageOptions("shared-only"));
  expect(result.copied).toBe(imageCount() - 1);
  expect(result.reused).toBe(1);
  expect(await fs.readFile(target(last))).toEqual(
    await fs.readFile(join(imageDirectory(root), ".retained", uploads[last].filename)),
  );
});
it("refuses conflicting immutable destination metadata before creating image directories", async () => {
  await stageDestination("shared-only");
  await reserveAssetManifest(
    destination,
    { kind: "transfer", id: "other" },
    { version: 1, entries: [{ ...bundle.index.manifest.entries[0], sha256: "b".repeat(64) }] },
  );
  await expect(
    installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
  ).rejects.toThrow();
  expect(await fs.readdir(destinationRoot)).toEqual([]);
});
it("refuses a released destination owner and retains source protection", async () => {
  await stageDestination("shared-only");
  const key = await destinationOwner("shared-only");
  await reserveAssetManifest(destination, key, bundle.index.manifest);
  await releaseAssetManifest(destination, key, "Reviewed");
  await expect(installRegisteredRecoveryBundleImages(imageOptions("shared-only"))).rejects.toThrow(
    "Released manifest owners",
  );
  expect((await inspectOwner()).record.state).toBe("retained");
  expect(await fs.readdir(destinationRoot)).toEqual([]);
});
it("commits no pins or files when the initial reservation commit fails", async () => {
  await stageDestination("shared-only");
  const wrapped = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        await work(tx);
        throw Error("Reservation commit failed");
      }),
  });
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions("shared-only"), destination: wrapped }),
  ).rejects.toThrow("Reservation commit failed");
  expect(await destination.values(sql`SELECT 1 FROM local_asset_manifest`)).toEqual([]);
  expect(await fs.readdir(destinationRoot)).toEqual([]);
});
it("keeps published bytes protected after a failed final commit and reuses them on retry", async () => {
  await stageDestination("shared-only");
  let writes = 0;
  const wrapped = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        const result = await work(tx);
        if (++writes === 2) throw Error("Final commit failed");
        return result;
      }),
  });
  await expect(
    installRegisteredRecoveryBundleImages({ ...imageOptions("shared-only"), destination: wrapped }),
  ).rejects.toThrow("Final commit failed");
  const key = await destinationOwner("shared-only");
  expect((await inspectAssetManifest(destination, key)).record.state).toBe("pending");
  expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
  await collectUnusedImages(destinationRoot, destination, Date.now() + 3 * 86400000);
  expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
  const retry = await installRegisteredRecoveryBundleImages(imageOptions("shared-only"));
  expect(retry.copied).toBe(0);
  expect(retry.reused).toBe(imageCount());
  expect(retry.changed).toBe(true);
  expect((await inspectAssetManifest(destination, key)).record.state).toBe("retained");
});
it.each(["sync", "link", "unlink"])(
  "preserves interrupted %s evidence and refuses automatic temporary-file repair",
  async (failure) => {
    await stageDestination("shared-only");
    const originalOpen = fs.open.bind(fs),
      originalLink = fs.link.bind(fs),
      originalUnlink = fs.unlink.bind(fs);
    let failed = false;
    if (failure === "sync")
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (
          String(args[0]) === temporary(0) &&
          typeof args[1] === "number" &&
          (args[1] & constants.O_WRONLY) !== 0
        )
          return new Proxy(handle, {
            get(target, property) {
              if (property === "sync")
                return async () => {
                  failed = true;
                  throw Error("Sync failed");
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        return handle;
      });
    if (failure === "link")
      vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
        if (String(to) === target(0)) {
          failed = true;
          throw Error("Link failed");
        }
        return originalLink(from, to);
      });
    if (failure === "unlink")
      vi.spyOn(fs, "unlink").mockImplementation(async (path) => {
        if (String(path) === temporary(0)) {
          failed = true;
          throw Error("Unlink failed");
        }
        return originalUnlink(path);
      });
    await expect(
      installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
    ).rejects.toThrow();
    expect(failed).toBe(true);
    expect((await fs.lstat(temporary(0))).isFile()).toBe(true);
    expect(
      (await inspectAssetManifest(destination, await destinationOwner("shared-only"))).record.state,
    ).toBe("pending");
    vi.restoreAllMocks();
    await expect(
      installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
    ).rejects.toThrow("Temporary destination image needs review");
    expect((await fs.lstat(temporary(0))).isFile()).toBe(true);
  },
);
it("retains completed destination images through cleanup and releases no earlier source owner", async () => {
  await stageDestination("shared-only");
  const result = await installRegisteredRecoveryBundleImages(imageOptions("shared-only"));
  await collectUnusedImages(destinationRoot, destination, Date.now() + 3 * 86400000);
  expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
  expect((await inspectOwner()).record.state).toBe("retained");
  await releaseAssetManifest(destination, result.owner, "Reviewed");
  await collectUnusedImages(destinationRoot, destination, Date.now() + 3 * 86400000);
  expect(await fs.readdir(imageDirectory(destinationRoot))).toEqual([".retained"]);
  expect(await fs.readdir(join(imageDirectory(destinationRoot), ".retained"))).toHaveLength(
    imageCount(),
  );
});
it("owns source and destination options before validation callbacks yield", async () => {
  await stageDestination("shared-only");
  const input = {
    ...imageOptions("shared-only"),
    expected: { ...identity },
    destinationExpected: { ...receiving },
    checkpoint: structuredClone(bundle.checkpoint) as any,
  };
  input.createValidationDatabase = async () => {
    input.destination = db;
    input.destinationRoot = root;
    input.destinationExpected.deviceId = "Changed";
    input.expected.deviceId = "Changed";
    input.checkpoint.sha256 = "b".repeat(64);
    input.root = join(root, "elsewhere");
    input.maxBytes = 0;
    return factory();
  };
  const result = await installRegisteredRecoveryBundleImages(input);
  expect(result.copied).toBe(imageCount());
  expect(result.destinationIdentity).toEqual(receiving);
});
it("serializes image completion with cleanup while the earlier committed pin remains visible", async () => {
  await stageDestination("shared-only");
  const second = await openDb(`file:${join(root, "destination.sqlite")}`);
  validationDatabases.push(second);
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  let writes = 0;
  const wrapped = createDatabaseAdapter(new Proxy(destination, {}), {
    read: (work) => withReadTx(destination, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(destination, async (tx) => {
        const result = await work(tx);
        if (++writes === 2) {
          entered.resolve();
          await proceed.promise;
        }
        return result;
      }),
  });
  const installing = installRegisteredRecoveryBundleImages({
      ...imageOptions("shared-only"),
      destination: wrapped,
    }),
    settled = installing.then(
      (result) => ({ result, error: null }),
      (error) => ({ result: null, error }),
    );
  try {
    await Promise.race([
      entered.promise,
      settled.then((value) => {
        if (value.error) throw value.error;
        throw Error("Installation did not reach the final transaction");
      }),
    ]);
    const key = await destinationOwner("shared-only");
    expect((await inspectAssetManifest(second.db, key)).record.state).toBe("pending");
    expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
    await second.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(
      collectUnusedImages(destinationRoot, second.db, Date.now() + 3 * 86400000),
    ).rejects.toThrow();
    proceed.resolve();
    expect((await settled).error).toBeNull();
    expect((await inspectAssetManifest(second.db, key)).record.state).toBe("retained");
    await collectUnusedImages(destinationRoot, second.db, Date.now() + 3 * 86400000);
    expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
  } finally {
    proceed.resolve();
    await settled;
  }
});
it.each(["corrupt", "symlink"])(
  "preserves %s destination archive evidence instead of hiding it behind live bytes",
  async (defect) => {
    await stageDestination("shared-only");
    const archive = join(imageDirectory(destinationRoot), ".retained");
    await fs.mkdir(imageDirectory(destinationRoot), { recursive: true });
    if (defect === "symlink") await fs.symlink(imageDirectory(root), archive);
    else {
      await fs.mkdir(archive);
      await fs.writeFile(join(archive, uploads[0].filename), "different");
      await fs.copyFile(file(0), target(0));
    }
    await expect(
      installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
    ).rejects.toThrow();
    expect(
      (await inspectAssetManifest(destination, await destinationOwner("shared-only"))).record.state,
    ).toBe("pending");
    if (defect === "corrupt")
      expect(await fs.readFile(join(archive, uploads[0].filename), "utf8")).toBe("different");
    else expect((await fs.lstat(archive)).isSymbolicLink()).toBe(true);
  },
);
it("rechecks destination bytes and source completeness even for retained retries", async () => {
  await stageDestination("shared-only");
  const result = await installRegisteredRecoveryBundleImages(imageOptions("shared-only"));
  await fs.unlink(published());
  await expect(
    installRegisteredRecoveryBundleImages(imageOptions("shared-only")),
  ).rejects.toThrow();
  expect((await inspectAssetManifest(destination, result.owner)).record.state).toBe("retained");
  expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
});
it("keeps a partial copy pinned and reuses verified files after the conflicting entry is reviewed", async () => {
  await stageDestination("shared-only");
  const last = requiredIndex(-1);
  await fs.mkdir(imageDirectory(destinationRoot), { recursive: true });
  await fs.writeFile(target(last), "conflicting bytes");
  await expect(installRegisteredRecoveryBundleImages(imageOptions("shared-only"))).rejects.toThrow(
    "Existing destination image",
  );
  expect(await fs.readdir(imageDirectory(destinationRoot))).toHaveLength(imageCount());
  expect(
    (await inspectAssetManifest(destination, await destinationOwner("shared-only"))).record.state,
  ).toBe("pending");
  expect(await fs.readFile(target(last), "utf8")).toBe("conflicting bytes");
  await fs.unlink(target(last));
  const retry = await installRegisteredRecoveryBundleImages(imageOptions("shared-only"));
  expect(retry.copied).toBe(1);
  expect(retry.reused).toBe(imageCount() - 1);
  expect((await inspectAssetManifest(destination, retry.owner)).record.state).toBe("retained");
});
it("binds the destination pin to content, mode and receiving identity independently of object key order", () => {
  const first = {
    checkpoint: bundle.checkpoint,
    destinationIdentity: identity,
    mode: "complete" as const,
  };
  const reordered = {
    mode: first.mode,
    destinationIdentity: {
      schemaId: identity.schemaId,
      checkpointId: identity.checkpointId,
      epochId: identity.epochId,
      deviceId: identity.deviceId,
      workspaceId: identity.workspaceId,
    },
    checkpoint: first.checkpoint,
  };
  const key = registeredRecoveryDestinationImageOwner(first);
  expect(registeredRecoveryDestinationImageOwner(reordered)).toEqual(key);
  expect(Object.isFrozen(key)).toBe(true);
  expect(registeredRecoveryDestinationImageOwner({ ...first, mode: "shared-only" })).not.toEqual(
    key,
  );
  expect(
    registeredRecoveryDestinationImageOwner({ ...first, destinationIdentity: receiving }),
  ).not.toEqual(key);
  expect(
    registeredRecoveryDestinationImageOwner({
      ...first,
      checkpoint: { ...bundle.checkpoint, sha256: "b".repeat(64) },
    }),
  ).not.toEqual(key);
});
