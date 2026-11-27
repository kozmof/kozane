import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
import {
  storeImage,
  imageDirectory,
  collectUnusedImages,
  retryImageDeletions,
} from "./image-assets.js";
import {
  inspectAssetManifest,
  reserveAssetManifest,
  releaseAssetManifest,
} from "../../db/api/asset-manifest.js";
import { abandonImageUpload } from "./image-upload-recovery.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { saveRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import { saveRegisteredSharedRecoveryExecutionPayload } from "./shared-recovery-execution-payload.js";
import { saveRegisteredSharedRecoveryActionPayload } from "./shared-recovery-action-payload.js";
import { saveRegisteredSharedRecoveryRunArchivePayload } from "./shared-recovery-run-archive-payload.js";
import { saveRegisteredSharedRecoveryActionArchivePayload } from "./shared-recovery-action-archive-payload.js";
import { saveRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import * as files from "./run-archive-asset-payload.js";
import * as imageEvidence from "./image-upload-evidence.js";
import {
  reserveRegisteredRecoveryCheckpointImages,
  retainRegisteredRecoveryCheckpointImages,
} from "./recovery-checkpoint-images.js";
import {
  saveRegisteredRecoveryBundle,
  loadRegisteredRecoveryBundle,
  inspectRecoveryBundlePublication,
} from "./recovery-bundle.js";
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
let bundle: Awaited<ReturnType<typeof recovery.describeRecoveryBundleIndex>>;
let uploads: (typeof localImageUploadTable.$inferSelect)[];
const required = Array.from({ length: 32 }, (_, n) => n).filter((n) => n !== 3);
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
const temporary = (name: Name) =>
  join(root, ".kozane", "recovery", area(name), `.pending-${checkpoints()[name].sha256}.json`);
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
const inspect = () => inspectRecoveryBundlePublication(root, bundle.checkpoint);
const directory = () => join(root, ".kozane", "recovery", "bundle-indexes");
const published = () => join(directory(), bundle.checkpoint.sha256 + ".json");
const pending = () => join(directory(), ".pending-" + bundle.checkpoint.sha256 + ".json");
const bytes = () => Buffer.from(JSON.stringify(bundle.index));
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
async function cleanup() {
  await collectUnusedImages(root, db);
  await retryImageDeletions(root, db);
}
async function handoff() {
  await abandonImageUpload(db, uploads[13].filename, "Retained by checkpoint", true);
  await releaseAssetManifest(db, stage, "Retained by checkpoint");
  const queue = join(imageDirectory(root), ".pending-delete");
  await fs.mkdir(queue, { recursive: true });
  for (let n = 0; n < uploads.length; n++) {
    await fs.writeFile(join(queue, uploads[n].filename), "");
    if (existsSync(file(n))) await fs.utimes(file(n), new Date(0), new Date(0));
  }
}
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mainDatabase?.close();
  mainDatabase = undefined;
  for (const opened of validationDatabases.splice(0)) opened.close();
  await fs.rm(root, { recursive: true, force: true });
});
it("publishes only after pending pins commit and physical images verify, then reopens exact contents", async () => {
  const before = await catalogs(),
    other = await openDb(`file:${join(root, "db.sqlite")}`),
    read = imageEvidence.inspectRetainedImage,
    link = fs.link;
  let reads = 0;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementation(async (...args) => {
    expect((await inspectAssetManifest(other.db, owner())).record.state).toBe("pending");
    reads++;
    return read(...args);
  });
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    expect(reads).toBeGreaterThanOrEqual(required.length);
    expect(await fs.readFile(String(args[0]))).toEqual(bytes());
    expect(existsSync(String(args[1]))).toBe(false);
    return link(...args);
  });
  try {
    expect(await save()).toEqual({
      path: published(),
      index: bundle.index,
      checkpoint: bundle.checkpoint,
      owner: owner(),
      changed: true,
    });
  } finally {
    other.close();
  }
  vi.restoreAllMocks();
  expect((await inspectOwner()).record.state).toBe("retained");
  expect(await fs.readFile(published())).toEqual(bytes());
  expect(existsSync(pending())).toBe(false);
  if (process.platform !== "win32") expect((await fs.stat(published())).mode & 0o777).toBe(0o600);
  const stat = await fs.stat(published(), { bigint: true }),
    record = (await inspectOwner()).record;
  expect((await save()).changed).toBe(false);
  expect(await fs.stat(published(), { bigint: true })).toMatchObject({
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
  });
  const result = await load();
  expect(result).toEqual({
    index: bundle.index,
    checkpoint: bundle.checkpoint,
    owner: owner(),
    contents: contents(),
  });
  expect(Object.isFrozen(result.contents)).toBe(true);
  expect(Object.isFrozen(result.contents.localSnapshot.tables)).toBe(true);
  expect(await catalogs()).toEqual(before);
  expect((await inspectOwner()).record).toEqual(record);
  expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});
it("keeps all broader, original and local images protected after staging handoff", async () => {
  await save();
  await handoff();
  await cleanup();
  for (const n of required) expect(existsSync(file(n))).toBe(true);
  expect(existsSync(file(3))).toBe(false);
  expect((await load()).index).toEqual(bundle.index);
});
it("verifies archived images without installing or rewriting them", async () => {
  const archive = join(imageDirectory(root), ".retained");
  await fs.mkdir(archive);
  for (const n of [8, 19, 27, 31]) await fs.rename(file(n), join(archive, uploads[n].filename));
  await save();
  expect((await load()).index).toEqual(bundle.index);
  for (const n of [8, 19, 27, 31]) {
    expect(existsSync(file(n))).toBe(false);
    expect(await fs.readFile(join(archive, uploads[n].filename), "utf8")).toBe(
      `<svg><text>${n}</text></svg>`,
    );
  }
});
it("inspects absent or orphaned evidence without creating directories or authorizing use", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_run_assets`);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(load()).rejects.toThrow();
  await expect(save()).rejects.toThrow();
});
it.each([
  "maxBytes",
  "localMaxBytes",
  "sharedMaxBytes",
  "executionMaxBytes",
  "actionMaxBytes",
  "actionArchiveMaxBytes",
  "runArchiveMaxBytes",
  "assetMaxBytes",
  "runAssetMaxBytes",
] as const)("refuses %s below the registered length before reads or allocation", async (field) => {
  const input = bundleOptions();
  input[field]--;
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  await expect(
    loadRegisteredRecoveryBundle({ ...input, createValidationDatabase: create }),
  ).rejects.toThrow("exceeds read limit");
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  await expect(inspectOwner()).rejects.toThrow("not found");
});
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid byte limit %s before reads",
  async (limit) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
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
      await expect(
        loadRegisteredRecoveryBundle({
          ...bundleOptions(),
          [field]: limit,
          createValidationDatabase: create,
        }),
      ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires the full original %s before reads",
  async (field) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredRecoveryBundle({
        ...bundleOptions(),
        expected: { ...identity, [field]: "other" },
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(Object.keys(tables) as Name[])(
  "requires %s registration before any file reads",
  async (name) => {
    await db.run(sql.raw(`DELETE FROM ${tables[name]}`));
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      saveRegisteredRecoveryBundle({
        ...bundleOptions(),
        input: bundle.index,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    await expect(
      loadRegisteredRecoveryBundle({ ...bundleOptions(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);
it.each(["manifest", "inventory", "hash", "source-binding"])(
  "refuses altered %s before source allocation or reservation",
  async (change) => {
    const index = JSON.parse(JSON.stringify(bundle.index)),
      checkpoint = JSON.parse(JSON.stringify(bundle.checkpoint));
    if (change === "manifest") index.manifest.entries.pop();
    if (change === "inventory") index.payloads.pop();
    if (change === "hash") checkpoint.sha256 = "b".repeat(64);
    if (change === "source-binding") checkpoint.runAssetCheckpoint.sha256 = "b".repeat(64);
    const create = vi.fn(factory);
    await expect(
      saveRegisteredRecoveryBundle({
        ...bundleOptions(),
        input: index,
        checkpoint,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await expect(inspectOwner()).rejects.toThrow("not found");
    expect(existsSync(directory())).toBe(false);
  },
);
it.each(["missing", "changed", "temporary"])(
  "refuses %s saved payloads without reserving or publishing",
  async (state) => {
    if (state === "missing") await fs.unlink(path("runs"));
    if (state === "changed") await fs.writeFile(path("runs"), "changed");
    if (state === "temporary") await fs.writeFile(temporary("runs"), "partial");
    await expect(save()).rejects.toThrow();
    await expect(inspectOwner()).rejects.toThrow("not found");
    expect(existsSync(directory())).toBe(false);
  },
);
it.each(["missing", "changed", "symlink"])(
  "keeps durable pending pins after %s required image failure",
  async (state) => {
    if (state === "missing") await fs.unlink(file(31));
    if (state === "changed") await fs.writeFile(file(31), "changed");
    if (state === "symlink") {
      await fs.rename(file(31), join(root, "outside"));
      await fs.symlink(join(root, "outside"), file(31));
    }
    await expect(save()).rejects.toThrow("Required image");
    expect((await inspectOwner()).record.state).toBe("pending");
    expect(existsSync(published())).toBe(false);
  },
);
it.each(["link", "unlink"] as const)(
  "preserves candidate evidence and pending pins after %s failure",
  async (failure) => {
    vi.spyOn(fs, failure).mockRejectedValueOnce(new Error("Publication failed"));
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: failure === "link" ? "absent" : "matching-content",
      temporary: "matching-content",
    });
    expect((await inspectOwner()).record.state).toBe("pending");
    await expect(load()).rejects.toThrow();
    await expect(save()).rejects.toThrow();
  },
);
it.each(["partial-write", "file-sync", "directory-sync"])(
  "retains interrupted evidence after %s",
  async (failure) => {
    if (failure === "directory-sync" && process.platform === "win32") return;
    const open = fs.open;
    let failed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!failed && String(args[0]) === (failure === "directory-sync" ? directory() : pending())) {
        failed = true;
        if (failure === "partial-write") {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await write(bytes().subarray(0, 10));
            throw Error("Partial write");
          });
        } else vi.spyOn(handle, "sync").mockRejectedValueOnce(Error("Sync failed"));
      }
      return handle;
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(failed).toBe(true);
    expect(await inspect()).toMatchObject({
      published: failure === "directory-sync" ? "matching-content" : "absent",
      temporary:
        failure === "directory-sync"
          ? "absent"
          : failure === "partial-write"
            ? "different-content"
            : "matching-content",
    });
    expect((await inspectOwner()).record.state).toBe("pending");
    await expect(load()).rejects.toThrow();
  },
);
it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary index evidence",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), pending());
    } else await fs.writeFile(pending(), state === "matching" ? bytes() : Buffer.from("partial"));
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(existsSync(published())).toBe(false);
    expect(await inspect()).toMatchObject({
      published: "absent",
      temporary:
        state === "matching"
          ? "matching-content"
          : state === "symlink"
            ? "unsafe-path"
            : "different-content",
    });
    expect((await inspectOwner()).record.state).toBe("pending");
  },
);
it.each(["different", "directory", "symlink"])(
  "refuses an existing %s index path without replacement",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "different") await fs.writeFile(published(), "different");
    if (state === "directory") await fs.mkdir(published());
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), published());
    }
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(existsSync(pending())).toBe(false);
  },
);
it("refuses a symlinked bundle directory without touching its target", async () => {
  await fs.mkdir(join(root, "outside"));
  await fs.symlink(join(root, "outside"), directory());
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await fs.readdir(join(root, "outside"))).toEqual([]);
});
it.each(["missing", "changed", "temporary", "symlink"])(
  "refuses %s published index bytes before source SQL allocation",
  async (state) => {
    await save();
    if (state === "missing") await fs.unlink(published());
    if (state === "changed") await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    if (state === "temporary") await fs.writeFile(pending(), bytes());
    if (state === "symlink") {
      await fs.rename(published(), join(root, "outside"));
      await fs.symlink(join(root, "outside"), published());
    }
    const create = vi.fn(factory),
      read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(
      loadRegisteredRecoveryBundle({ ...bundleOptions(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);
it.each(["utf8", "json", "bom", "noncanonical"])(
  "refuses hash-matching invalid %s index bytes before source allocation",
  async (state) => {
    const data =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(bundle.index))
            : Buffer.from(JSON.stringify(bundle.index, null, 2));
    const checkpoint = {
      ...bundle.checkpoint,
      byteLength: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), checkpoint.sha256 + ".json"), data);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredRecoveryBundle({
        ...bundleOptions(),
        checkpoint,
        maxBytes: data.length,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    await expect(inspectOwner()).rejects.toThrow("not found");
  },
);
it.each(["absent", "pending", "released"])(
  "never repairs %s image protection while loading a matching index",
  async (state) => {
    if (state === "pending") await reserveRegisteredRecoveryCheckpointImages(options());
    if (state === "released") {
      await retainRegisteredRecoveryCheckpointImages(options());
      await releaseAssetManifest(db, owner(), "Retired checkpoint");
    }
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(published(), bytes());
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(load()).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    if (state === "absent") await expect(inspectOwner()).rejects.toThrow("not found");
    else expect((await inspectOwner()).record.state).toBe(state);
  },
);
it.each(Object.keys(tables) as Name[])(
  "refuses %s catalog removal after source validation without publishing",
  async (name) => {
    const original = files.loadRegisteredRunArchiveAssetContents;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetContents").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        await db.run(sql.raw(`DELETE FROM ${tables[name]}`));
        return result;
      },
    );
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(save()).rejects.toThrow("binding changed");
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(directory())).toBe(false);
    await expect(inspectOwner()).rejects.toThrow("not found");
  },
);
it.each(Object.keys(tables) as Name[])(
  "refuses changed %s source bytes after loader verification",
  async (name) => {
    await save();
    const before = (await inspectOwner()).record,
      original = files.loadRegisteredRunArchiveAssetContents;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetContents").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        await fs.writeFile(path(name), "changed");
        return result;
      },
    );
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(load()).rejects.toThrow("needs review");
    expect(read).not.toHaveBeenCalled();
    expect((await inspectOwner()).record).toEqual(before);
  },
);
it.each(Object.keys(tables) as Name[])(
  "preserves an unusable candidate if %s changes during publication",
  async (name) => {
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
      await fs.writeFile(path(name), "changed");
      return link(...args);
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect((await inspectOwner()).record.state).toBe("pending");
    await expect(load()).rejects.toThrow();
  },
);
it.each(["removed", "rewritten", "replaced", "temporary"])(
  "refuses %s index identity after source validation",
  async (change) => {
    await save();
    const before = (await inspectOwner()).record,
      original = files.loadRegisteredRunArchiveAssetContents;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetContents").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        if (change === "removed") await fs.unlink(published());
        if (change === "rewritten") {
          await fs.writeFile(published(), bytes());
          await fs.utimes(published(), new Date(2000), new Date(2000));
        }
        if (change === "replaced") {
          await fs.writeFile(join(directory(), "other"), bytes());
          await fs.rename(join(directory(), "other"), published());
        }
        if (change === "temporary") await fs.writeFile(pending(), bytes());
        return result;
      },
    );
    await expect(load()).rejects.toThrow();
    expect((await inspectOwner()).record).toEqual(before);
  },
);
it("rechecks the published index after the final physical image verification", async () => {
  const read = imageEvidence.inspectRetainedImage;
  let calls = 0;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementation(async (...args) => {
    if (++calls === required.length + 1) await fs.writeFile(published(), "changed");
    return read(...args);
  });
  await expect(save()).rejects.toThrow("index changed during publication");
  expect((await inspectOwner()).record.state).toBe("pending");
  expect(await inspect()).toMatchObject({ published: "different-content", temporary: "absent" });
  await expect(load()).rejects.toThrow();
});
it.each(["reservation", "publication"])(
  "preserves prior protection and candidate evidence after %s commit failure",
  async (phase) => {
    const original = files.loadRegisteredRunArchiveAssetContents;
    let ready = false,
      writes = 0;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetContents").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        ready = true;
        return result;
      },
    );
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(db, async (tx) => {
          const result = await work(tx);
          if (ready && ++writes === (phase === "reservation" ? 1 : 2)) {
            await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
            await tx.run(
              sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
            );
            await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
          }
          return result;
        }),
    });
    await expect(
      saveRegisteredRecoveryBundle({ ...bundleOptions(), db: wrapped, input: bundle.index }),
    ).rejects.toThrow();
    if (phase === "reservation") {
      await expect(inspectOwner()).rejects.toThrow("not found");
      expect(existsSync(published())).toBe(false);
    } else {
      expect((await inspectOwner()).record.state).toBe("pending");
      expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
      await expect(load()).rejects.toThrow("image protection");
    }
    expect((await inspectAssetManifest(db, stage)).record.state).toBe("pending");
    expect((await save()).changed).toBe(phase === "reservation");
    expect((await load()).index).toEqual(bundle.index);
  },
);
it("preserves a retained owner and final bytes if a verification read commit fails", async () => {
  await save();
  const before = (await inspectOwner()).record,
    read = imageEvidence.inspectRetainedImage;
  let ready = false;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementation(async (...args) => {
    ready = true;
    return read(...args);
  });
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(db, async (tx) => {
        const result = await work(tx);
        if (ready) {
          await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
          await tx.run(
            sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
          );
          await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
        }
        return result;
      }),
  });
  await expect(loadRegisteredRecoveryBundle({ ...bundleOptions(), db: wrapped })).rejects.toThrow();
  expect((await inspectOwner()).record).toEqual(before);
  expect(await fs.readFile(published())).toEqual(bytes());
  expect((await load()).index).toEqual(bundle.index);
});
it("serializes all catalog and owner removals across publication", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    for (const table of [...Object.values(tables), "local_asset_manifest"]) {
      await other.db.values(sql`PRAGMA busy_timeout=1`);
      await expect(
        withTx(other.db, (tx) => tx.run(sql.raw(`DELETE FROM ${table}`))),
      ).rejects.toThrow();
    }
    return link(...args);
  });
  try {
    await save();
  } finally {
    other.close();
  }
  expect((await load()).index).toEqual(bundle.index);
});
it("refuses narrower earlier protection without replacing its owner", async () => {
  const {
    actionArchiveMaxBytes: _archive,
    runArchiveMaxBytes: _runs,
    runAssetMaxBytes: _assets,
    actionMaxBytes: _actions,
    ...old
  } = options();
  await reserveRegisteredRecoveryCheckpointImages(old);
  const before = (await inspectOwner()).record;
  await expect(save()).rejects.toThrow("different asset manifest");
  expect((await inspectOwner()).record).toEqual(before);
  expect(existsSync(directory())).toBe(false);
});
it.each(["save", "load"])(
  "owns identity, expectations, paths, input and all limits during %s validation",
  async (mode) => {
    if (mode === "load") await save();
    const input = {
      ...bundleOptions(),
      input: JSON.parse(JSON.stringify(bundle.index)),
      expected: { ...identity },
      checkpoint: JSON.parse(JSON.stringify(bundle.checkpoint)),
    };
    input.createValidationDatabase = async () => {
      input.root = join(root, "elsewhere");
      input.expected.deviceId = "changed";
      input.checkpoint.sha256 = "b".repeat(64);
      input.input.manifest.entries.length = 0;
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
    if (mode === "save") await saveRegisteredRecoveryBundle(input);
    else expect((await loadRegisteredRecoveryBundle(input)).index).toEqual(bundle.index);
    expect(await fs.readFile(published())).toEqual(bytes());
  },
);
it("rechecks physical bytes and keeps retained pins after a later missing original-only image", async () => {
  await save();
  const before = (await inspectOwner()).record;
  await fs.unlink(file(31));
  await expect(load()).rejects.toThrow("Required image");
  expect((await inspectOwner()).record).toEqual(before);
});
it("loads published records without recovery-file writes, image installation or owner updates", async () => {
  await save();
  const before = (await inspectOwner()).record,
    mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  expect((await load()).contents).toEqual(contents());
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" && (call[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
  expect((await inspectOwner()).record).toEqual(before);
});

it("rejects owner changes during loading without promoting them", async () => {
  await save();
  const before = (await inspectOwner()).record,
    read = imageEvidence.inspectRetainedImage;
  let active: DatabaseHandle | undefined;
  const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
    read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(db, async (tx) => {
        active = tx;
        try {
          return await work(tx);
        } finally {
          active = undefined;
        }
      }),
  });
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    expect(active).toBeDefined();
    await active!.run(
      sql`UPDATE local_asset_manifest SET state='pending',verified_at=NULL WHERE owner_kind='recovery'`,
    );
    return read(...args);
  });
  await expect(loadRegisteredRecoveryBundle({ ...bundleOptions(), db: wrapped })).rejects.toThrow(
    "owner changed",
  );
  expect((await inspectOwner()).record).toEqual(before);
  expect(await fs.readFile(published())).toEqual(bytes());
});
