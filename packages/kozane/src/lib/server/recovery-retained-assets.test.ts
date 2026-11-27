import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
} from "@kozane/core/database";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { localImageUploadTable } from "../../db/schema.js";
import {
  retainedRecoveryAssetFixture,
  identity,
  filename,
} from "../../test-utils/retained-recovery-assets.js";
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
import { saveRegisteredSharedRecoveryRetainedPayload } from "./shared-recovery-retained-payload.js";
import { saveRegisteredRecoveryAssetPayload } from "./recovery-asset-payload.js";
import * as files from "./retained-recovery-asset-payload.js";
import * as imageEvidence from "./image-upload-evidence.js";
import {
  reserveRegisteredRecoveryCheckpointImages,
  retainRegisteredRecoveryCheckpointImages,
} from "./recovery-checkpoint-images.js";
vi.mock("./retained-recovery-asset-payload.js", async (original) => ({
  ...(await original<typeof import("./retained-recovery-asset-payload.js")>()),
}));
let root: string,
  db: Awaited<ReturnType<typeof createTestDB>>,
  source: Awaited<ReturnType<typeof retainedRecoveryAssetFixture>>,
  assets: Awaited<ReturnType<typeof recovery.describeRetainedRecoveryAssets>>;
let uploads: (typeof localImageUploadTable.$inferSelect)[];
const required = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const stage = { kind: "transfer" as const, id: "stage" };
const owner = () => registeredLocalRecoveryImageOwner(identity);
const factory = () => createTestDB();
const file = (n: number) => join(imageDirectory(root), uploads[n].filename);
function checkpoints() {
  const retained = source.binding.checkpoint,
    originals = retained.checkpoint,
    executions = originals.checkpoint;
  return {
    assets: assets.checkpoint,
    retained,
    originals,
    executions,
    shared: executions.checkpoint,
    local: source.binding.localCheckpoint,
    current: source.assetCheckpoint,
  };
}
const tables = {
  assets: "local_recovery_retained_assets",
  retained: "local_recovery_retained_history",
  originals: "local_recovery_actions",
  executions: "local_recovery_executions",
  shared: "local_recovery_shared_history",
  local: "local_recovery_checkpoint",
  current: "local_recovery_assets",
} as const;
type Name = keyof typeof tables;
const area = (name: Name) =>
  ({
    assets: "retained-asset-manifests",
    retained: "retained-history",
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
  retainedMaxBytes: checkpoints().retained.byteLength,
  assetMaxBytes: checkpoints().current.byteLength,
  retainedAssetMaxBytes: assets.checkpoint.byteLength,
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
  root = await fs.mkdtemp(join(tmpdir(), "kozane-retained-image-work-"));
  db = await createTestDB(join(root, "db.sqlite"));
  uploads = [];
  for (let n = 0; n < 17; n++) {
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
  for (let n = 0; n < 17; n++)
    if (n !== 13)
      await db.run(
        sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${uploads[n].filename}`,
      );
  let json = JSON.stringify(await retainedRecoveryAssetFixture());
  for (let n = 0; n < 17; n++) json = json.replaceAll(filename(n), uploads[n].filename);
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
  for (const run of f.retainedHistory.effectSets) {
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
  const retained = await recovery.describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    selection: f.retainedHistory.selection,
    effectSets: f.retainedHistory.effectSets,
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
    binding: { checkpoint: retained.checkpoint, localCheckpoint: local.checkpoint },
    assetCheckpoint: current.checkpoint,
    history: f.history,
    originalImages: f.originalImages,
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    executions: executions.payload,
    originalActions: originals.payload,
    retainedHistory: retained.payload,
    currentAssets: current.payload,
  };
  assets = await recovery.describeRetainedRecoveryAssets(source);
  await recovery.rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  await recovery.rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  await recovery.rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  await recovery.rememberSharedRecoveryRetainedCheckpoint(db, retained.checkpoint);
  await recovery.rememberRecoveryAssetCheckpoint(db, current.checkpoint);
  await recovery.rememberRetainedRecoveryAssetCheckpoint(db, assets.checkpoint);
  const ctx = options();
  await saveRegisteredLocalRecoveryPayload({ ...ctx, input: local.snapshot });
  await saveRegisteredSharedRecoveryPayload({ ...ctx, input: shared.payload });
  await saveRegisteredSharedRecoveryExecutionPayload({ ...ctx, input: executions.payload });
  await saveRegisteredSharedRecoveryActionPayload({ ...ctx, input: originals.payload });
  await saveRegisteredSharedRecoveryRetainedPayload({ ...ctx, input: retained.payload });
  await saveRegisteredRecoveryAssetPayload({
    root,
    db,
    expected: identity,
    localMaxBytes: ctx.localMaxBytes,
    sharedMaxBytes: ctx.sharedMaxBytes,
    createValidationDatabase: factory,
    input: current.payload,
  });
  await files.saveRegisteredRetainedRecoveryAssetPayload({ ...ctx, input: assets.payload });
  await reserveAssetManifest(db, stage, assets.payload.manifest);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      retainedBinding: assets.checkpoint.binding,
      retainedAssetCheckpoint: assets.checkpoint,
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
  for (const n of [5, 7, 8]) await fs.rename(file(n), join(archive, uploads[n].filename));
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
        retainedAssetMaxBytes: limit,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("positive safe integer");
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);
it.each([
  "retainedMaxBytes",
  "retainedAssetMaxBytes",
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
      load = files.loadRegisteredRetainedRecoveryAssetPayload;
    vi.spyOn(files, "loadRegisteredRetainedRecoveryAssetPayload").mockImplementationOnce(
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
    load = files.loadRegisteredRetainedRecoveryAssetPayload;
  vi.spyOn(files, "loadRegisteredRetainedRecoveryAssetPayload").mockImplementationOnce(
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
it.each(["retained", "assets"] as const)(
  "refuses %s temporary evidence created after loading",
  async (name) => {
    const load = files.loadRegisteredRetainedRecoveryAssetPayload;
    vi.spyOn(files, "loadRegisteredRetainedRecoveryAssetPayload").mockImplementationOnce(
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
it.each(["origin-missing", "superseded-changed", "original-skipped-changed"])(
  "preserves pending pins after %s image failure",
  async (defect) => {
    await reserve();
    const before = (await inspect()).record;
    if (defect === "origin-missing") await fs.unlink(file(5));
    else await fs.writeFile(file(defect === "superseded-changed" ? 8 : 12), "changed");
    await expect(retain()).rejects.toThrow("Required image");
    expect((await inspect()).record).toEqual(before);
  },
);
it.each(["reservation", "verification"])(
  "rolls back %s if owner publication changes a retained binding",
  async (phase) => {
    if (phase === "verification") await reserve();
    await db.run(
      sql.raw(
        phase === "reservation"
          ? "CREATE TRIGGER remove_retained AFTER INSERT ON local_asset_manifest WHEN NEW.owner_kind='recovery' BEGIN DELETE FROM local_recovery_retained_assets; END"
          : "CREATE TRIGGER remove_retained AFTER UPDATE OF state ON local_asset_manifest WHEN NEW.owner_kind='recovery' AND NEW.state='retained' BEGIN DELETE FROM local_recovery_retained_history; END",
      ),
    );
    await expect(phase === "reservation" ? reserve() : retain()).rejects.toThrow("binding changed");
    if (phase === "reservation") await expect(inspect()).rejects.toThrow("not found");
    else expect((await inspect()).record.state).toBe("pending");
    expect(
      await recovery.inspectRetainedRecoveryAssetCheckpoint(db, {
        workspaceId: identity.workspaceId,
        deviceId: identity.deviceId,
        epochId: identity.epochId,
        checkpointId: identity.checkpointId,
      }),
    ).toEqual(assets.checkpoint);
  },
);
it("preserves the earlier owner when retained coverage adds requirements under the same checkpoint key", async () => {
  const {
    retainedMaxBytes: _retained,
    retainedAssetMaxBytes: _assets,
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
it.each(["file", "temporary"])(
  "rechecks retained %s evidence after image verification",
  async (change) => {
    await reserve();
    const before = (await inspect()).record,
      read = imageEvidence.inspectRetainedImage;
    vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
      if (change === "file") await fs.writeFile(path("retained"), "changed");
      else await fs.writeFile(temporary("assets"), "partial");
      return read(...args);
    });
    await expect(retain()).rejects.toThrow("needs review");
    expect((await inspect()).record).toEqual(before);
    await handoff();
    await cleanup();
    for (const n of required) expect(existsSync(file(n))).toBe(true);
  },
);
it.each(["reservation", "verification"])(
  "preserves prior protection after the final %s commit fails",
  async (phase) => {
    let ready = false,
      writes = 0;
    const load = files.loadRegisteredRetainedRecoveryAssetPayload;
    vi.spyOn(files, "loadRegisteredRetainedRecoveryAssetPayload").mockImplementationOnce(
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
it("holds the image lock across all seven catalog bindings during image verification", async () => {
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
it.each(["retainedMaxBytes", "retainedAssetMaxBytes"] as const)(
  "refuses a registered payload above %s before allocation",
  async (field) => {
    const input = options();
    input[field]--;
    const create = vi.fn(factory),
      read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(
      retainRegisteredRecoveryCheckpointImages({ ...input, createValidationDatabase: create }),
    ).rejects.toThrow("exceeds read limit");
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);
it("owns retained read limits, identity and root before validation callbacks", async () => {
  const input = { ...options(), expected: { ...identity } };
  input.createValidationDatabase = async () => {
    input.root = join(root, "elsewhere");
    input.expected.deviceId = "changed";
    input.retainedMaxBytes = 0;
    input.retainedAssetMaxBytes = 0;
    input.assetMaxBytes = 0;
    input.actionMaxBytes = 0;
    input.executionMaxBytes = 0;
    return factory();
  };
  expect((await retainRegisteredRecoveryCheckpointImages(input)).state).toBe("retained");
  expect((await inspect()).manifest).toEqual(assets.payload.manifest);
});
function checkOptionTypes(input: ReturnType<typeof options>) {
  const { retainedMaxBytes: _retained, ...missingRetained } = input;
  // @ts-expect-error Saved retained manifest coverage requires the history read limit.
  void reserveRegisteredRecoveryCheckpointImages(missingRetained);
  const history: recovery.SharedRecoveryHistoryImages = {
    baseline: { id: "baseline", manifest: { version: 1, entries: [] } },
    effectSets: [],
  };
  // @ts-expect-error Host manifests cannot be combined with retained manifest coverage.
  void reserveRegisteredRecoveryCheckpointImages({ ...input, history });
}
void checkOptionTypes;
