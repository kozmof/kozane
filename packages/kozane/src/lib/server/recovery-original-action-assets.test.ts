import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { mergeAssetManifests } from "@kozane/core";
import { migrations } from "@kozane/core/migrations";
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
  inspectAssetManifest,
  reserveAssetManifest,
  releaseAssetManifest,
} from "../../db/api/asset-manifest.js";
import {
  storeImage,
  imageDirectory,
  collectUnusedImages,
  retryImageDeletions,
} from "./image-assets.js";
import { abandonImageUpload } from "./image-upload-recovery.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { saveRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import * as executionFiles from "./shared-recovery-execution-payload.js";
import * as actionFiles from "./shared-recovery-action-payload.js";
import * as assetFiles from "./recovery-asset-payload.js";
import * as imageEvidence from "./image-upload-evidence.js";
import { registeredLocalRecoveryImageOwner } from "./local-recovery-images.js";
import {
  reserveRegisteredRecoveryCheckpointImages,
  retainRegisteredRecoveryCheckpointImages,
} from "./recovery-checkpoint-images.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
}));
vi.mock("./shared-recovery-execution-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-execution-payload.js")>()),
}));
vi.mock("./recovery-asset-payload.js", async (original) => ({
  ...(await original<typeof import("./recovery-asset-payload.js")>()),
}));

vi.mock("./shared-recovery-action-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-action-payload.js")>()),
}));
let originals: Awaited<ReturnType<typeof recovery.describeSharedRecoveryActions>>;
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof recovery.captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof recovery.describeSharedRecoveryHistory>>;
let executions: Awaited<ReturnType<typeof recovery.describeSharedRecoveryExecutions>>;
let assets: Awaited<ReturnType<typeof recovery.describeRecoveryAssets>>;
let uploads: (typeof localImageUploadTable.$inferSelect)[];
const identity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const stage = { kind: "transfer" as const, id: "stage" };
const owner = () => registeredLocalRecoveryImageOwner(identity);
const factory = () => createTestDB();
const manifest = (...indices: number[]) =>
  mergeAssetManifests([
    {
      version: 1,
      entries: indices.map((n) => ({
        name: `.kozane/assets/images/${uploads[n].filename}`,
        byteLength: uploads[n].byteLength,
        sha256: uploads[n].sha256,
      })),
    },
  ]);
const reference = (n: number) => `kozane-image:/api/images/${uploads[n].filename}`;
const history = () => ({
  baseline: { id: "baseline", manifest: manifest(7, 8) },
  effectSets: [
    { id: "edit", manifest: manifest(0, 1, 4, 5, 6) },
    { id: "empty", manifest: manifest(3) },
  ],
});
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  executionMaxBytes: executions.checkpoint.byteLength,
  actionMaxBytes: originals.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const assetOptions = () => ({ ...options(), maxBytes: assets.checkpoint.byteLength });
const imageOptions = () => ({ ...options(), assetMaxBytes: assets.checkpoint.byteLength });
const actionPath = () =>
  join(root, ".kozane", "recovery", "actions", `${originals.checkpoint.sha256}.json`);
const actionTemporary = () =>
  join(root, ".kozane", "recovery", "actions", `.pending-${originals.checkpoint.sha256}.json`);
const assetDirectory = () => join(root, ".kozane", "recovery", "asset-manifests");
const assetPath = () => join(assetDirectory(), `${assets.checkpoint.sha256}.json`);
const file = (n: number) => join(imageDirectory(root), uploads[n].filename);
const save = () =>
  assetFiles.saveRegisteredRecoveryAssetPayload({ ...assetOptions(), input: assets.payload });
const load = () => assetFiles.loadRegisteredRecoveryAssetPayload(assetOptions());
const reserve = () => reserveRegisteredRecoveryCheckpointImages(imageOptions());
const retain = () => retainRegisteredRecoveryCheckpointImages(imageOptions());
const inspect = () => inspectAssetManifest(db, owner());
const executionBinding = () => ({
  checkpoint: executions.checkpoint,
  localCheckpoint: local.checkpoint,
});
const actionBinding = () => ({
  checkpoint: originals.checkpoint,
  localCheckpoint: local.checkpoint,
});
const catalogs = async () => {
  const result = [];
  for (const table of [
    "local_recovery_checkpoint",
    "local_recovery_shared_history",
    "local_recovery_executions",
    "local_recovery_assets",
    "local_recovery_actions",
  ])
    result.push(await db.values(sql.raw(`SELECT * FROM ${table}`)));
  return result;
};
async function registerAssets(images = history()) {
  assets = await recovery.describeRecoveryAssets({
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    history: images,
  });
  await recovery.rememberRecoveryAssetCheckpoint(db, assets.checkpoint);
}
async function saveWithoutOriginalCoverage() {
  const { actionMaxBytes: _actionMaxBytes, ...base } = assetOptions();
  return assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload });
}
async function handoff() {
  await abandonImageUpload(db, uploads[2].filename, "Retained by checkpoint", true);
  await releaseAssetManifest(db, stage, "Retained by checkpoint");
  const queue = join(imageDirectory(root), ".pending-delete");
  await fs.mkdir(queue, { recursive: true });
  for (let n = 0; n < uploads.length; n++) {
    await fs.writeFile(join(queue, uploads[n].filename), "");
    if (existsSync(file(n))) await fs.utimes(file(n), new Date(0), new Date(0));
  }
}
async function cleanup() {
  await collectUnusedImages(root, db);
  await retryImageDeletions(root, db);
}
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-original-assets-"));
  db = await createTestDB(join(root, "db.sqlite"));
  uploads = [];
  for (let n = 0; n < 9; n++) {
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
  for (const n of [0, 1, 3, 4, 5, 6, 7, 8])
    await db.run(
      sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${uploads[n].filename}`,
    );
  local = await recovery.captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  const row = (n: number) => ({
    id: ["text", "n"] as const,
    name: ["text", reference(n)] as const,
    is_default: ["integer", "0"] as const,
  });
  shared = await recovery.describeSharedRecoveryHistory(
    {
      baseline: {
        id: "baseline",
        projection: {
          version: 1,
          rowEncodingVersion: 1,
          schemaId: identity.schemaId,
          tables: [
            "namespace",
            "partition",
            "layer",
            "scope",
            "taskspace",
            "inventory",
            "card",
            "glue",
            "glue_rel",
            "scope_rel",
            "scope_area",
            "warp",
          ].map((name) => ({ name, rows: [] })),
        },
      },
      effectSets: [
        {
          id: "edit",
          effects: [
            {
              ord: 0,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "I",
              before: null,
              after: row(0),
            },
            {
              ord: 1,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "U",
              before: row(0),
              after: row(1),
            },
            {
              ord: 2,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "D",
              before: row(1),
              after: null,
            },
          ],
        },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", effectCount: 3 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  await recovery.rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  const invocation = {
    id: "root",
    kind: "future.root",
    contractVersion: 99,
    input: { ref: reference(5) },
  };
  const empty = {
    id: "empty-root",
    kind: "future.empty",
    contractVersion: 99,
    input: { ref: reference(3) },
  };
  const generated = {
    child: { type: "child-id", value: "child" },
    noop: { type: "child-id", value: "noop" },
    unused: { type: "entity-id", value: "unused" },
    skipped: { type: "child-id", value: "skipped" },
  };
  executions = await recovery.describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", rootId: "root", executionCount: 3 },
        { id: "empty", rootId: "empty-root", executionCount: 1 },
      ],
    },
    effectSets: [
      {
        id: "edit",
        invocation,
        generated,
        executions: [
          {
            ...invocation,
            parentId: null,
            executionOrd: 0,
            generated: { child: generated.child, noop: generated.noop },
          },
          {
            id: "child",
            kind: "future.child",
            contractVersion: 99,
            input: { ref: reference(6) },
            parentId: "root",
            executionOrd: 1,
            generated: {},
          },
          {
            id: "noop",
            kind: "future.noop",
            contractVersion: 99,
            input: { ref: reference(4) },
            parentId: "root",
            executionOrd: 2,
            generated: {},
          },
        ],
        effects: [
          { ord: 0, actionId: "root", executionOrd: 0 },
          { ord: 1, actionId: "child", executionOrd: 1 },
          { ord: 2, actionId: "root", executionOrd: 0 },
        ],
      },
      {
        id: "empty",
        invocation: empty,
        generated: {},
        executions: [{ ...empty, parentId: null, executionOrd: 0, generated: {} }],
        effects: [],
      },
    ],
  });
  await recovery.rememberSharedRecoveryExecutionCheckpoint(db, executions.checkpoint);
  const provenance = {
    hlc: "opaque:first-record",
    deviceId: "first-record-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
  };
  originals = await recovery.describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: { actionIds: ["root", "child", "noop", "skipped", "empty-root"] },
    actions: [
      { ...invocation, rootId: "root", parentId: null, generated, seq: "1", ...provenance },
      {
        id: "child",
        rootId: "root",
        parentId: "root",
        kind: "future.child",
        contractVersion: 99,
        input: { ref: reference(7) },
        generated: {},
        seq: "2",
        ...provenance,
      },
      {
        id: "noop",
        rootId: "root",
        parentId: "root",
        kind: "future.noop",
        contractVersion: 99,
        input: { ref: reference(4) },
        generated: {},
        seq: "3",
        ...provenance,
      },
      {
        id: "skipped",
        rootId: "root",
        parentId: "root",
        kind: "future.skipped",
        contractVersion: 99,
        input: { ref: reference(8) },
        generated: {},
        seq: "4",
        ...provenance,
      },
      {
        ...empty,
        rootId: "empty-root",
        parentId: null,
        generated: {},
        seq: "9007199254740993",
        ...provenance,
      },
    ],
  });
  await recovery.rememberSharedRecoveryActionCheckpoint(db, originals.checkpoint);
  await reserveAssetManifest(db, stage, manifest(0, 1, 2, 3, 4, 5, 6, 7, 8));
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
  await executionFiles.saveRegisteredSharedRecoveryExecutionPayload({
    ...options(),
    input: executions.payload,
  });
  await actionFiles.saveRegisteredSharedRecoveryActionPayload({
    ...options(),
    input: originals.payload,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("saves and reopens manifests with original and current coverage without changing intent or images", async () => {
  await registerAssets();
  const before = await catalogs(),
    originalBytes = await fs.readFile(actionPath()),
    read = vi.spyOn(imageEvidence, "inspectRetainedImage");
  expect(await save()).toMatchObject({
    changed: true,
    checkpoint: assets.checkpoint,
    executionBinding: executionBinding(),
    actionBinding: actionBinding(),
  });
  const stat = await fs.stat(assetPath(), { bigint: true });
  expect((await save()).changed).toBe(false);
  expect(await fs.stat(assetPath(), { bigint: true })).toMatchObject({
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
  });
  const targets: Awaited<ReturnType<typeof factory>>[] = [];
  const loaded = await assetFiles.loadRegisteredRecoveryAssetPayload({
    ...assetOptions(),
    createValidationDatabase: async () => {
      const target = await factory();
      targets.push(target);
      return target;
    },
  });
  expect(loaded).toEqual({
    payload: assets.payload,
    checkpoint: assets.checkpoint,
    executionBinding: executionBinding(),
    actionBinding: actionBinding(),
  });
  expect(Object.isFrozen(loaded.actionBinding)).toBe(true);
  expect(Object.isFrozen(loaded)).toBe(true);
  expect(targets).toHaveLength(7);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM local_image_upload`)).toEqual([]);
  }
  expect(await catalogs()).toEqual(before);
  expect(await fs.readFile(actionPath())).toEqual(originalBytes);
  expect(read).not.toHaveBeenCalled();
  await expect(inspect()).rejects.toThrow("not found");
});

it("covers originals through the combined manifest while preserving per-set current execution checks", async () => {
  const images = history();
  images.baseline.manifest = manifest();
  images.effectSets[1].manifest = manifest(3, 7, 8);
  await registerAssets(images);
  await save();
  expect((await load()).payload.manifest).toEqual(manifest(0, 1, 2, 3, 4, 5, 6, 7, 8));
  expect((await reserve()).actionBinding).toEqual(actionBinding());
});

it.each([
  ["first child input", 7],
  ["skipped child", 8],
] as const)(
  "refuses a missing original %s image even when selected execution coverage passes",
  async (_label, n) => {
    const images = history();
    images.baseline.manifest = n === 7 ? manifest(8) : manifest(7);
    await registerAssets(images);
    await expect(save()).rejects.toThrow("Required asset is missing");
    expect(existsSync(assetDirectory())).toBe(false);
    await saveWithoutOriginalCoverage();
    const before = await fs.readFile(assetPath()),
      read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(load()).rejects.toThrow("Required asset is missing");
    await expect(reserve()).rejects.toThrow("Required asset is missing");
    await expect(retain()).rejects.toThrow("Required asset is missing");
    expect(await fs.readFile(assetPath())).toEqual(before);
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it("still requires current per-set images that differ from the original invocation", async () => {
  const images = history();
  images.baseline.manifest = manifest(6, 7, 8);
  images.effectSets[0].manifest = manifest(0, 1, 4, 5);
  await registerAssets(images);
  expect(assets.payload.manifest).toEqual(manifest(0, 1, 2, 3, 4, 5, 6, 7, 8));
  await expect(save()).rejects.toThrow("Required asset is missing");
  expect(existsSync(assetDirectory())).toBe(false);
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses action limit %s before files or validation allocation",
  async (actionMaxBytes) => {
    await registerAssets();
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    const base = { ...assetOptions(), actionMaxBytes, createValidationDatabase: create };
    await expect(
      assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload }),
    ).rejects.toThrow("positive safe integer");
    await expect(assetFiles.loadRegisteredRecoveryAssetPayload(base)).rejects.toThrow(
      "positive safe integer",
    );
    await expect(
      retainRegisteredRecoveryCheckpointImages({
        ...imageOptions(),
        actionMaxBytes,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it("requires an execution read limit with original coverage before file reads", async () => {
  await registerAssets();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  const { executionMaxBytes: _executionMaxBytes, ...base } = assetOptions();
  await expect(
    assetFiles.saveRegisteredRecoveryAssetPayload({
      ...base,
      input: assets.payload,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow("requires an execution read limit");
  await expect(
    assetFiles.loadRegisteredRecoveryAssetPayload({ ...base, createValidationDatabase: create }),
  ).rejects.toThrow("requires an execution read limit");
  const invalid = {
    ...base,
    assetMaxBytes: assets.checkpoint.byteLength,
    createValidationDatabase: create,
  } as unknown as Parameters<typeof retainRegisteredRecoveryCheckpointImages>[0];
  await expect(retainRegisteredRecoveryCheckpointImages(invalid)).rejects.toThrow(
    "requires an execution read limit",
  );
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("refuses an original descriptor above its read limit before file opens", async () => {
  await registerAssets();
  await saveWithoutOriginalCoverage();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory),
    actionMaxBytes = originals.checkpoint.byteLength - 1;
  const base = { ...assetOptions(), actionMaxBytes, createValidationDatabase: create };
  await expect(
    assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload }),
  ).rejects.toThrow("exceeds read limit");
  await expect(assetFiles.loadRegisteredRecoveryAssetPayload(base)).rejects.toThrow(
    "exceeds read limit",
  );
  await expect(
    retainRegisteredRecoveryCheckpointImages({
      ...imageOptions(),
      actionMaxBytes,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow("exceeds read limit");
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("refuses original coverage with host history before file reads", async () => {
  await registerAssets();
  const open = vi.spyOn(fs, "open");
  const invalid = { ...options(), history: history() } as unknown as Parameters<
    typeof retainRegisteredRecoveryCheckpointImages
  >[0];
  await expect(retainRegisteredRecoveryCheckpointImages(invalid)).rejects.toThrow(
    "requires saved manifests",
  );
  expect(open).not.toHaveBeenCalled();
});

it.each([
  "missing-action",
  "local-binding",
  "execution-binding",
  "orphan-execution",
  "orphan-shared",
  "orphan-local",
])("refuses %s expectations before file reads", async (change) => {
  await registerAssets();
  await saveWithoutOriginalCoverage();
  if (change === "missing-action") await db.run(sql`DELETE FROM local_recovery_actions`);
  if (change === "local-binding")
    await db.run(
      sql`UPDATE local_recovery_actions SET local_descriptor=${JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) })}`,
    );
  if (change === "execution-binding")
    await db.run(
      sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...originals.checkpoint, checkpoint: { ...executions.checkpoint, sha256: "b".repeat(64) } })}`,
    );
  if (change === "orphan-execution") await db.run(sql`DELETE FROM local_recovery_executions`);
  if (change === "orphan-shared") await db.run(sql`DELETE FROM local_recovery_shared_history`);
  if (change === "orphan-local") await db.run(sql`DELETE FROM local_recovery_checkpoint`);
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory),
    base = { ...assetOptions(), createValidationDatabase: create };
  await expect(
    assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload }),
  ).rejects.toThrow();
  await expect(assetFiles.loadRegisteredRecoveryAssetPayload(base)).rejects.toThrow();
  await expect(
    retainRegisteredRecoveryCheckpointImages({
      ...imageOptions(),
      createValidationDatabase: create,
    }),
  ).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it.each(["missing", "corrupt", "symlink", "temporary"])(
  "refuses %s original bytes before source SQL or image reads",
  async (change) => {
    await registerAssets();
    await saveWithoutOriginalCoverage();
    if (change === "missing") await fs.unlink(actionPath());
    if (change === "corrupt") await fs.writeFile(actionPath(), "changed");
    if (change === "symlink") {
      const outside = join(root, "outside");
      await fs.rename(actionPath(), outside);
      await fs.symlink(outside, actionPath());
    }
    if (change === "temporary") await fs.writeFile(actionTemporary(), "partial");
    const create = vi.fn(factory),
      read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(
      assetFiles.saveRegisteredRecoveryAssetPayload({
        ...assetOptions(),
        input: assets.payload,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    await expect(
      assetFiles.loadRegisteredRecoveryAssetPayload({
        ...assetOptions(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    await expect(
      retainRegisteredRecoveryCheckpointImages({
        ...imageOptions(),
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it.each(["save", "load"])(
  "rechecks the action binding after %s source validation",
  async (operation) => {
    await registerAssets();
    if (operation === "load") await save();
    const original = actionFiles.loadRegisteredSharedRecoveryActionPayload;
    vi.spyOn(actionFiles, "loadRegisteredSharedRecoveryActionPayload").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        await db.run(
          sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...originals.checkpoint, sha256: "b".repeat(64) })}`,
        );
        return result;
      },
    );
    await expect(operation === "save" ? save() : load()).rejects.toThrow(
      "action checkpoint binding changed",
    );
    expect(existsSync(assetPath())).toBe(operation === "load");
  },
);

it.each(["save", "load"])(
  "refuses coherent replacement of all five catalogs before final %s success",
  async (operation) => {
    await registerAssets();
    if (operation === "load") await save();
    const require = recovery.requireRecoveryAssetCheckpoint;
    vi.spyOn(recovery, "requireRecoveryAssetCheckpoint").mockImplementationOnce(async (...args) => {
      const result = await require(...args),
        nextLocal = { ...local.checkpoint, sha256: "b".repeat(64) },
        nextShared = { ...shared.checkpoint, sha256: "c".repeat(64) },
        nextExecution = {
          ...executions.checkpoint,
          checkpoint: nextShared,
          sha256: "d".repeat(64),
        };
      await withTx(db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(nextShared)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify(nextExecution)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_actions SET descriptor=${JSON.stringify({ ...originals.checkpoint, checkpoint: nextExecution })},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...assets.checkpoint, binding: { checkpoint: nextShared, localCheckpoint: nextLocal } })}`,
        );
      });
      return result;
    });
    await expect(operation === "save" ? save() : load()).rejects.toThrow("binding changed");
    expect(existsSync(assetPath())).toBe(operation === "load");
  },
);

it.each([
  ["save", "bytes"],
  ["save", "temporary"],
  ["load", "bytes"],
  ["load", "temporary"],
])("%s rechecks original %s after source validation", async (operation, change) => {
  await registerAssets();
  if (operation === "load") await save();
  let calls = 0;
  const input = {
    ...assetOptions(),
    createValidationDatabase: async () => {
      if (++calls === 4)
        await fs.writeFile(change === "bytes" ? actionPath() : actionTemporary(), "changed");
      return factory();
    },
  };
  await expect(
    operation === "save"
      ? assetFiles.saveRegisteredRecoveryAssetPayload({ ...input, input: assets.payload })
      : assetFiles.loadRegisteredRecoveryAssetPayload(input),
  ).rejects.toThrow("actions payload needs review");
  expect(calls).toBe(7);
});

it("preserves published manifest evidence if original bytes change during publication", async () => {
  await registerAssets();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    await fs.writeFile(actionPath(), "changed");
    return link(...args);
  });
  await expect(save()).rejects.toThrow("inspect retained evidence");
  const { schemaId: _schemaId, ...key } = identity;
  expect(await assetFiles.inspectRegisteredRecoveryAssetPayload(root, db, key)).toMatchObject({
    published: "matching-content",
    temporary: "absent",
  });
});

it.each(["save", "load"])(
  "preserves evidence when the final original-covered %s commit fails",
  async (operation) => {
    await registerAssets();
    if (operation === "load") await save();
    let ready = false;
    const require = recovery.requireRecoveryAssetCheckpoint;
    vi.spyOn(recovery, "requireRecoveryAssetCheckpoint").mockImplementationOnce(async (...args) => {
      const result = await require(...args);
      ready = true;
      return result;
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
    const before = await catalogs();
    await expect(
      operation === "save"
        ? assetFiles.saveRegisteredRecoveryAssetPayload({
            ...assetOptions(),
            db: wrapped,
            input: assets.payload,
          })
        : assetFiles.loadRegisteredRecoveryAssetPayload({ ...assetOptions(), db: wrapped }),
    ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await catalogs()).toEqual(before);
    expect(await fs.readFile(assetPath())).toEqual(Buffer.from(JSON.stringify(assets.payload)));
    expect((await save()).changed).toBe(false);
  },
);

it("commits protection before image reads and protects original-only images through cleanup", async () => {
  await registerAssets();
  await save();
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    read = imageEvidence.inspectRetainedImage;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    expect((await inspectAssetManifest(other.db, owner())).record.state).toBe("pending");
    return read(...args);
  });
  try {
    expect(await reserve()).toMatchObject({
      state: "pending",
      actionBinding: actionBinding(),
      executionBinding: executionBinding(),
      assetCheckpoint: assets.checkpoint,
      manifest: manifest(0, 1, 2, 3, 4, 5, 6, 7, 8),
    });
    await handoff();
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
    expect((await retain()).state).toBe("retained");
    const before = (await inspect()).record;
    expect((await retain()).changed).toBe(false);
    expect((await inspect()).record).toEqual(before);
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
  } finally {
    other.close();
  }
});

it("verifies an archived original skipped-child image without reinstalling it", async () => {
  await registerAssets();
  await save();
  const archive = join(imageDirectory(root), ".retained");
  await fs.mkdir(archive);
  const target = join(archive, uploads[8].filename);
  await fs.rename(file(8), target);
  const before = await fs.readFile(target);
  expect((await retain()).state).toBe("retained");
  expect(existsSync(file(8))).toBe(false);
  expect(await fs.readFile(target)).toEqual(before);
});

it.each(["binding", "file", "temporary"])(
  "refuses changed original %s after loading and preserves earlier protection",
  async (change) => {
    await registerAssets();
    await save();
    await reserve();
    const before = (await inspect()).record,
      original = assetFiles.loadRegisteredRecoveryAssetPayload;
    vi.spyOn(assetFiles, "loadRegisteredRecoveryAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        if (change === "binding") await db.run(sql`DELETE FROM local_recovery_actions`);
        if (change === "file") await fs.unlink(actionPath());
        if (change === "temporary") await fs.writeFile(actionTemporary(), "partial");
        return result;
      },
    );
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(retain()).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect((await inspect()).record).toEqual(before);
    await handoff();
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
  },
);

it.each(["reservation", "verification"])(
  "rolls back %s if owner publication changes the action binding",
  async (phase) => {
    await registerAssets();
    await save();
    if (phase === "reservation")
      await db.run(
        sql`CREATE TRIGGER remove_originals AFTER INSERT ON local_asset_manifest WHEN NEW.owner_kind='recovery' BEGIN DELETE FROM local_recovery_actions; END`,
      );
    else
      await db.run(
        sql`CREATE TRIGGER remove_originals AFTER UPDATE OF state ON local_asset_manifest WHEN NEW.owner_kind='recovery' AND NEW.state='retained' BEGIN DELETE FROM local_recovery_actions; END`,
      );
    await expect(retain()).rejects.toThrow("action checkpoint binding changed");
    if (phase === "reservation") await expect(inspect()).rejects.toThrow("not found");
    else expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    expect((await db.values(sql`SELECT descriptor FROM local_recovery_actions`))[0][0]).toBe(
      JSON.stringify(originals.checkpoint),
    );
  },
);

it.each(["file", "temporary"])(
  "preserves pending protection if original %s changes during image verification",
  async (change) => {
    await registerAssets();
    await save();
    const original = imageEvidence.inspectRetainedImage;
    vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await fs.writeFile(change === "file" ? actionPath() : actionTemporary(), "changed");
      return result;
    });
    await expect(retain()).rejects.toThrow("actions payload needs review");
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    await handoff();
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
  },
);

it.each(["missing-first-child", "changed-skipped"])(
  "preserves protection after %s image verification failure",
  async (change) => {
    await registerAssets();
    await save();
    if (change === "missing-first-child") await fs.unlink(file(7));
    else await fs.writeFile(file(8), "changed");
    await expect(retain()).rejects.toThrow("Required image");
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
  },
);

it("preserves retained protection if its original payload later disappears", async () => {
  await registerAssets();
  await save();
  await retain();
  const before = (await inspect()).record;
  await fs.unlink(actionPath());
  await expect(retain()).rejects.toThrow();
  expect((await inspect()).record).toEqual(before);
  await handoff();
  await cleanup();
  expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
});

it.each(["save", "load", "retain"])(
  "owns original limits, identity, root and manifest input before %s callbacks",
  async (operation) => {
    await registerAssets();
    if (operation !== "save") await save();
    const input = {
      ...imageOptions(),
      ...assetOptions(),
      input: JSON.parse(JSON.stringify(assets.payload)),
      expected: { ...identity },
    };
    input.createValidationDatabase = async () => {
      input.actionMaxBytes = 0;
      input.executionMaxBytes = 0;
      input.root = join(root, "elsewhere");
      input.expected.deviceId = "changed";
      input.input.history.baseline.manifest.entries.length = 0;
      return factory();
    };
    if (operation === "save")
      expect((await assetFiles.saveRegisteredRecoveryAssetPayload(input)).actionBinding).toEqual(
        actionBinding(),
      );
    if (operation === "load")
      expect((await assetFiles.loadRegisteredRecoveryAssetPayload(input)).actionBinding).toEqual(
        actionBinding(),
      );
    if (operation === "retain")
      expect((await retainRegisteredRecoveryCheckpointImages(input)).actionBinding).toEqual(
        actionBinding(),
      );
  },
);

it.each(["reservation", "verification"])(
  "preserves original image protection after %s commit failure",
  async (phase) => {
    await registerAssets();
    await save();
    const before = await catalogs();
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(db, async (tx) => {
          const result = await work(tx),
            rows = await tx.values(
              sql`SELECT state FROM local_asset_manifest WHERE owner_kind='recovery' AND owner_id=${owner().id}`,
            );
          if (rows[0]?.[0] === (phase === "reservation" ? "pending" : "retained")) {
            await tx.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
            await tx.run(
              sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
            );
            await tx.run(sql`INSERT INTO deferred_child VALUES('missing')`);
          }
          return result;
        }),
    });
    const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
    await expect(
      retainRegisteredRecoveryCheckpointImages({ ...imageOptions(), db: wrapped }),
    ).rejects.toThrow();
    if (phase === "reservation") {
      await expect(inspect()).rejects.toThrow("not found");
      expect(read).not.toHaveBeenCalled();
    } else {
      expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
      expect(read).toHaveBeenCalledTimes(uploads.length);
    }
    expect(await catalogs()).toEqual(before);
    expect((await retain()).state).toBe("retained");
  },
);

it.each(["publication", "verification"])(
  "serializes all five catalog changes during %s",
  async (phase) => {
    await registerAssets();
    if (phase === "verification") await save();
    const other = await openDb(`file:${join(root, "db.sqlite")}`),
      entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    if (phase === "publication") {
      const original = fs.link;
      vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await proceed.promise;
        return original(...args);
      });
    } else {
      const original = imageEvidence.inspectRetainedImage;
      vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
        entered.resolve();
        await proceed.promise;
        return original(...args);
      });
    }
    const work = phase === "publication" ? save() : retain();
    try {
      await entered.promise;
      for (const table of [
        "local_recovery_actions",
        "local_recovery_executions",
        "local_recovery_assets",
        "local_recovery_shared_history",
        "local_recovery_checkpoint",
      ]) {
        await other.db.values(sql`PRAGMA busy_timeout=1`);
        await expect(
          withTx(other.db, (tx) => tx.run(sql.raw(`DELETE FROM ${table}`))),
        ).rejects.toThrow();
      }
      if (phase === "verification") {
        await other.db.values(sql`PRAGMA busy_timeout=1`);
        await expect(
          releaseAssetManifest(other.db, owner(), "Competing release"),
        ).rejects.toThrow();
        await other.db.values(sql`PRAGMA busy_timeout=1`);
        await expect(collectUnusedImages(root, other.db)).rejects.toThrow();
      }
      proceed.resolve();
      await work;
    } finally {
      proceed.resolve();
      await work.catch(() => undefined);
      other.close();
    }
  },
);
