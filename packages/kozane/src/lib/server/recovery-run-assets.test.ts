import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
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
vi.mock("./run-archive-asset-payload.js", async (original) => ({
  ...(await original<typeof import("./run-archive-asset-payload.js")>()),
}));
let root: string,
  db: Awaited<ReturnType<typeof factory>>,
  source: Awaited<ReturnType<typeof runArchiveAssetFixture>>,
  assets: Awaited<ReturnType<typeof recovery.describeRunArchiveAssets>>;
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
const reserve = () => reserveRegisteredRecoveryCheckpointImages(options());
const retain = () => retainRegisteredRecoveryCheckpointImages(options());
const inspect = () => inspectAssetManifest(db, owner());
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
  root = await fs.mkdtemp(join(tmpdir(), "kozane-run-image-work-"));
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mainDatabase?.close();
  mainDatabase = undefined;
  for (const opened of validationDatabases.splice(0)) opened.close();
  await fs.rm(root, { recursive: true, force: true });
});
it("commits protection before reads and preserves origin, superseded, skipped and local images through cleanup", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    read = imageEvidence.inspectRetainedImage;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    expect((await inspectAssetManifest(other.db, owner())).record.state).toBe("pending");
    return read(...args);
  });
  try {
    const result = await reserve();
    expect(result).toMatchObject({
      state: "pending",
      manifest: assets.payload.manifest,
      owner: owner(),
      actionArchiveBinding: {
        checkpoint: checkpoints().archive,
        localCheckpoint: checkpoints().local,
      },
      runArchiveBinding: assets.checkpoint.binding,
      runAssetCheckpoint: assets.checkpoint,
      assetCheckpoint: source.assetCheckpoint,
    });
    await handoff();
    await cleanup();
    for (const n of required) expect(existsSync(file(n))).toBe(true);
    expect(existsSync(file(3))).toBe(false);
    expect((await retain()).state).toBe("retained");
    const before = (await inspect()).record;
    expect((await retain()).changed).toBe(false);
    expect((await inspect()).record).toEqual(before);
    await cleanup();
    for (const n of required) expect(existsSync(file(n))).toBe(true);
  } finally {
    other.close();
  }
});
it("verifies archived origin and superseded image bytes without reinstalling them", async () => {
  const archive = join(imageDirectory(root), ".retained");
  await fs.mkdir(archive);
  for (const n of [5, 7, 8, 18, 23, 27, 31])
    await fs.rename(file(n), join(archive, uploads[n].filename));
  expect((await retain()).state).toBe("retained");
  for (const n of [5, 7, 8]) {
    expect(existsSync(file(n))).toBe(false);
    expect(await fs.readFile(join(archive, uploads[n].filename), "utf8")).toBe(
      `<svg><text>${n}</text></svg>`,
    );
  }
});
it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid retained manifest limit %s before reads or reservation",
  async (limit) => {
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage"),
      create = vi.fn(factory);
    await expect(
      retainRegisteredRecoveryCheckpointImages({
        ...options(),
        runAssetMaxBytes: limit,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("positive safe integer");
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);
it.each([
  "actionArchiveMaxBytes",
  "runArchiveMaxBytes",
  "runAssetMaxBytes",
  "assetMaxBytes",
  "actionMaxBytes",
  "executionMaxBytes",
] as const)("requires %s with retained coverage", async (field) => {
  const input: any = { ...options() };
  delete input[field];
  const create = vi.fn(factory);
  await expect(
    retainRegisteredRecoveryCheckpointImages({ ...input, createValidationDatabase: create }),
  ).rejects.toThrow("all saved source read limits");
  expect(create).not.toHaveBeenCalled();
  await expect(inspect()).rejects.toThrow("not found");
});
it("refuses retained coverage with host manifests before SQL allocation", async () => {
  const input: any = { ...options(), history: source.currentAssets.history },
    create = vi.fn(factory);
  await expect(
    retainRegisteredRecoveryCheckpointImages({ ...input, createValidationDatabase: create }),
  ).rejects.toThrow("saved manifests");
  expect(create).not.toHaveBeenCalled();
});
it.each(Object.keys(tables) as Name[])(
  "rechecks %s after loading and preserves earlier pins",
  async (name) => {
    await reserve();
    const before = (await inspect()).record,
      load = files.loadRegisteredRunArchiveAssetPayload;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await load(...args);
        await db.run(sql.raw(`DELETE FROM ${tables[name]}`));
        return result;
      },
    );
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(retain()).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect((await inspect()).record).toEqual(before);
    await handoff();
    await cleanup();
    for (const n of required) expect(existsSync(file(n))).toBe(true);
  },
);
it.each(Object.keys(tables) as Name[])("rechecks %s saved bytes after loading", async (name) => {
  await reserve();
  const before = (await inspect()).record,
    load = files.loadRegisteredRunArchiveAssetPayload;
  vi.spyOn(files, "loadRegisteredRunArchiveAssetPayload").mockImplementationOnce(
    async (...args) => {
      const result = await load(...args);
      await fs.writeFile(path(name), "changed");
      return result;
    },
  );
  const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
  await expect(retain()).rejects.toThrow("needs review");
  expect(read).not.toHaveBeenCalled();
  expect((await inspect()).record).toEqual(before);
});
it.each(["runs", "archive", "assets"] as const)(
  "refuses %s temporary evidence created after loading",
  async (name) => {
    const load = files.loadRegisteredRunArchiveAssetPayload;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await load(...args);
        await fs.writeFile(temporary(name), "partial");
        return result;
      },
    );
    await expect(reserve()).rejects.toThrow("needs review");
    expect(await fs.readFile(temporary(name), "utf8")).toBe("partial");
  },
);
it.each([
  "origin-missing",
  "superseded-changed",
  "original-skipped-changed",
  "detached-authoritative-missing",
  "detached-nested-changed",
  "never-executed-changed",
])("preserves pending pins after %s image failure", async (defect) => {
  await reserve();
  const before = (await inspect()).record;
  if (defect.endsWith("missing")) await fs.unlink(file(defect === "origin-missing" ? 5 : 27));
  else
    await fs.writeFile(
      file(
        defect === "superseded-changed"
          ? 8
          : defect === "detached-nested-changed"
            ? 19
            : defect === "never-executed-changed"
              ? 31
              : 12,
      ),
      "changed",
    );
  await expect(retain()).rejects.toThrow("Required image");
  expect((await inspect()).record).toEqual(before);
});
it.each(
  (["reservation", "verification"] as const).flatMap((phase) =>
    (Object.keys(tables) as Name[]).map((name) => ({ phase, name })),
  ),
)("$phase rolls back if owner publication removes $name", async ({ phase, name }) => {
  if (phase === "verification") await reserve();
  await db.run(
    sql.raw(
      phase === "reservation"
        ? `CREATE TRIGGER remove_retained AFTER INSERT ON local_asset_manifest WHEN NEW.owner_kind='recovery' BEGIN DELETE FROM ${tables[name]}; END`
        : `CREATE TRIGGER remove_retained AFTER UPDATE OF state ON local_asset_manifest WHEN NEW.owner_kind='recovery' AND NEW.state='retained' BEGIN DELETE FROM ${tables[name]}; END`,
    ),
  );
  await expect(phase === "reservation" ? reserve() : retain()).rejects.toThrow("binding changed");
  if (phase === "reservation") await expect(inspect()).rejects.toThrow("not found");
  else expect((await inspect()).record.state).toBe("pending");
  expect(
    await recovery.inspectRunArchiveAssetCheckpoint(db, {
      workspaceId: identity.workspaceId,
      deviceId: identity.deviceId,
      epochId: identity.epochId,
      checkpointId: identity.checkpointId,
    }),
  ).toEqual(assets.checkpoint);
});
it("preserves the earlier owner when retained coverage adds requirements under the same checkpoint key", async () => {
  const {
    actionArchiveMaxBytes: _archive,
    runArchiveMaxBytes: _runs,
    runAssetMaxBytes: _assets,
    actionMaxBytes: _actions,
    ...old
  } = options();
  await reserveRegisteredRecoveryCheckpointImages(old);
  const before = (await inspect()).record;
  await expect(reserve()).rejects.toThrow("different asset manifest");
  expect((await inspect()).record).toEqual(before);
  expect(before.manifest).not.toBe(JSON.stringify(assets.payload.manifest));
});
it("preserves retained protection if a required saved payload later disappears", async () => {
  await retain();
  const before = (await inspect()).record;
  await fs.unlink(path("assets"));
  await expect(retain()).rejects.toThrow();
  expect((await inspect()).record).toEqual(before);
  await handoff();
  await cleanup();
  for (const n of required) expect(existsSync(file(n))).toBe(true);
});
it.each(
  (Object.keys(tables) as Name[]).flatMap((name) =>
    ["file", "temporary"].map((change) => ({ name, change })),
  ),
)("rechecks $name $change evidence after image verification", async ({ name, change }) => {
  await reserve();
  const before = (await inspect()).record,
    read = imageEvidence.inspectRetainedImage;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    if (change === "file") await fs.writeFile(path(name), "changed");
    else await fs.writeFile(temporary(name), "partial");
    return read(...args);
  });
  await expect(retain()).rejects.toThrow("needs review");
  expect((await inspect()).record).toEqual(before);
  await handoff();
  await cleanup();
  for (const n of required) expect(existsSync(file(n))).toBe(true);
});
it.each(["reservation", "verification"])(
  "preserves prior protection after the final %s commit fails",
  async (phase) => {
    let ready = false,
      writes = 0;
    const load = files.loadRegisteredRunArchiveAssetPayload;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await load(...args);
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
      retainRegisteredRecoveryCheckpointImages({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    if (phase === "reservation") await expect(inspect()).rejects.toThrow("not found");
    else expect((await inspect()).record.state).toBe("pending");
    expect((await inspectAssetManifest(db, stage)).record.state).toBe("pending");
    expect((await retain()).state).toBe("retained");
  },
);
it("holds the image lock across all eight catalog bindings during image verification", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    read = imageEvidence.inspectRetainedImage;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    for (const table of [...Object.values(tables), "local_asset_manifest"]) {
      await other.db.values(sql`PRAGMA busy_timeout=1`);
      await expect(
        withTx(other.db, (tx) => tx.run(sql.raw(`DELETE FROM ${table}`))),
      ).rejects.toThrow();
    }
    return read(...args);
  });
  try {
    expect((await retain()).state).toBe("retained");
  } finally {
    other.close();
  }
});
it.each([
  "localMaxBytes",
  "sharedMaxBytes",
  "executionMaxBytes",
  "actionMaxBytes",
  "assetMaxBytes",
  "actionArchiveMaxBytes",
  "runArchiveMaxBytes",
  "runAssetMaxBytes",
] as const)("refuses a registered payload above %s before allocation", async (field) => {
  const input = options();
  input[field]--;
  const create = vi.fn(factory),
    read = vi.spyOn(imageEvidence, "inspectRetainedImage");
  await expect(
    retainRegisteredRecoveryCheckpointImages({ ...input, createValidationDatabase: create }),
  ).rejects.toThrow("exceeds read limit");
  expect(create).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it("owns retained read limits, identity and root before validation callbacks", async () => {
  const input = { ...options(), expected: { ...identity } };
  input.createValidationDatabase = async () => {
    input.root = join(root, "elsewhere");
    input.expected.deviceId = "changed";
    input.actionArchiveMaxBytes = 0;
    input.runArchiveMaxBytes = 0;
    input.runAssetMaxBytes = 0;
    input.assetMaxBytes = 0;
    input.actionMaxBytes = 0;
    input.executionMaxBytes = 0;
    return factory();
  };
  expect((await retainRegisteredRecoveryCheckpointImages(input)).state).toBe("retained");
  expect((await inspect()).manifest).toEqual(assets.payload.manifest);
});
function checkOptionTypes(input: ReturnType<typeof options>) {
  const { runArchiveMaxBytes: _retained, ...missingRetained } = input;
  // @ts-expect-error Broader run coverage requires the run archive read limit.
  void reserveRegisteredRecoveryCheckpointImages(missingRetained);
  const history: recovery.SharedRecoveryHistoryImages = {
    baseline: { id: "baseline", manifest: { version: 1, entries: [] } },
    effectSets: [],
  };
  // @ts-expect-error Host manifests cannot be combined with broader run coverage.
  void reserveRegisteredRecoveryCheckpointImages({ ...input, history });
  const { actionArchiveMaxBytes: _archive, ...missingArchive } = input;
  // @ts-expect-error Broader run coverage requires the original archive read limit.
  void reserveRegisteredRecoveryCheckpointImages(missingArchive);
  const { runAssetMaxBytes: _assets, ...missingAssets } = input;
  // @ts-expect-error Broader run coverage requires the manifest read limit.
  void reserveRegisteredRecoveryCheckpointImages(missingAssets);
  // @ts-expect-error Selected-root and broader run manifest policies cannot be combined.
  void reserveRegisteredRecoveryCheckpointImages({
    ...input,
    retainedMaxBytes: 1,
    retainedAssetMaxBytes: 1,
  });
}
void checkOptionTypes;

it.each(["retainedMaxBytes", "retainedAssetMaxBytes"])(
  "refuses mixed %s before allocation",
  async (field) => {
    const create = vi.fn(factory),
      read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(
      retainRegisteredRecoveryCheckpointImages({
        ...options(),
        [field]: 1,
        createValidationDatabase: create,
      } as never),
    ).rejects.toThrow("Choose run archive");
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it.each(Object.keys(tables) as Name[])(
  "rechecks exact %s catalog contents after byte verification",
  async (name) => {
    await reserve();
    const before = (await inspect()).record,
      read = imageEvidence.inspectRetainedImage;
    let activeWrite: DatabaseHandle | undefined;
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(db, async (tx) => {
          activeWrite = tx;
          try {
            return await work(tx);
          } finally {
            activeWrite = undefined;
          }
        }),
    });
    vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
      expect(activeWrite).toBeDefined();
      await activeWrite!.run(
        sql`UPDATE ${sql.raw(tables[name])} SET descriptor=${JSON.stringify({ ...checkpoints()[name], sha256: "b".repeat(64) })}`,
      );
      return read(...args);
    });
    await expect(
      retainRegisteredRecoveryCheckpointImages({ ...options(), db: wrapped }),
    ).rejects.toThrow("binding changed");
    expect((await inspect()).record).toEqual(before);
  },
);

it.each(["runs", "archive", "originals", "executions", "shared"] as const)(
  "rechecks original local binding on %s after loading",
  async (name) => {
    const load = files.loadRegisteredRunArchiveAssetPayload;
    vi.spyOn(files, "loadRegisteredRunArchiveAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await load(...args);
        await db.run(
          sql`UPDATE ${sql.raw(tables[name])} SET local_descriptor=${JSON.stringify({ ...checkpoints().local, sha256: "b".repeat(64) })}`,
        );
        return result;
      },
    );
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(retain()).rejects.toThrow("binding changed");
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it("preserves retained pins after later image corruption", async () => {
  await retain();
  const before = (await inspect()).record;
  await fs.writeFile(file(31), "changed");
  await expect(retain()).rejects.toThrow("Required image");
  expect((await inspect()).record).toEqual(before);
});
