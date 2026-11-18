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
  baseline: { id: "baseline", manifest: manifest() },
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
  createValidationDatabase: factory,
});
const assetOptions = () => ({ ...options(), maxBytes: assets.checkpoint.byteLength });
const imageOptions = () => ({ ...options(), assetMaxBytes: assets.checkpoint.byteLength });
const executionPath = () =>
  join(root, ".kozane", "recovery", "executions", `${executions.checkpoint.sha256}.json`);
const executionTemporary = () =>
  join(root, ".kozane", "recovery", "executions", `.pending-${executions.checkpoint.sha256}.json`);
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
const catalogs = async () => {
  const result = [];
  for (const table of [
    "local_recovery_checkpoint",
    "local_recovery_shared_history",
    "local_recovery_executions",
    "local_recovery_assets",
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
async function saveWithoutExecutionCoverage() {
  const { executionMaxBytes: _executionMaxBytes, ...base } = assetOptions();
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
  root = await fs.mkdtemp(join(tmpdir(), "kozane-execution-assets-"));
  db = await createTestDB(join(root, "db.sqlite"));
  uploads = [];
  for (let n = 0; n < 7; n++) {
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
  for (const n of [0, 1, 3, 4, 5, 6])
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
  await reserveAssetManifest(db, stage, manifest(0, 1, 2, 3, 4, 5, 6));
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
  await executionFiles.saveRegisteredSharedRecoveryExecutionPayload({
    ...options(),
    input: executions.payload,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("saves and reopens manifests with trusted execution coverage without changing catalog intent or images", async () => {
  await registerAssets();
  const before = await catalogs(),
    executionBytes = await fs.readFile(executionPath());
  const read = vi.spyOn(imageEvidence, "inspectRetainedImage");
  expect(await save()).toMatchObject({
    changed: true,
    checkpoint: assets.checkpoint,
    executionBinding: executionBinding(),
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
  });
  expect(Object.isFrozen(loaded)).toBe(true);
  expect(Object.isFrozen(loaded.executionBinding)).toBe(true);
  expect(targets).toHaveLength(4);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM local_image_upload`)).toEqual([]);
  }
  expect(await catalogs()).toEqual(before);
  expect(await fs.readFile(executionPath())).toEqual(executionBytes);
  expect(read).not.toHaveBeenCalled();
  await expect(inspect()).rejects.toThrow("not found");
});

it.each([
  ["root", 5, 0],
  ["child", 6, 0],
  ["no-op child", 4, 0],
  ["zero-effect root", 3, 1],
] as const)(
  "refuses a missing %s image in its own set even when the combined manifest is unchanged",
  async (_label, n, index) => {
    const images = history();
    images.baseline.manifest = manifest(n);
    images.effectSets[index].manifest = mergeAssetManifests([
      {
        version: 1,
        entries: images.effectSets[index].manifest.entries.filter(
          (entry) => entry.name !== manifest(n).entries[0].name,
        ),
      },
    ]);
    await registerAssets(images);
    expect(assets.payload.manifest).toEqual(manifest(0, 1, 2, 3, 4, 5, 6));
    await expect(save()).rejects.toThrow("Required asset is missing");
    expect(existsSync(assetDirectory())).toBe(false);
    // Existing row-only workflows remain explicit. Opting into execution coverage must refuse these bytes.
    await saveWithoutExecutionCoverage();
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

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "refuses execution limit %s before files or validation allocation",
  async (executionMaxBytes) => {
    await registerAssets();
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    const base = { ...assetOptions(), executionMaxBytes, createValidationDatabase: create };
    await expect(
      assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload }),
    ).rejects.toThrow("positive safe integer");
    await expect(assetFiles.loadRegisteredRecoveryAssetPayload(base)).rejects.toThrow(
      "positive safe integer",
    );
    await expect(
      retainRegisteredRecoveryCheckpointImages({
        ...imageOptions(),
        executionMaxBytes,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it("refuses an execution descriptor above the host limit before file opens", async () => {
  await registerAssets();
  await saveWithoutExecutionCoverage();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  const base = {
    ...assetOptions(),
    executionMaxBytes: executions.checkpoint.byteLength - 1,
    createValidationDatabase: create,
  };
  await expect(
    assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload }),
  ).rejects.toThrow("exceeds read limit");
  await expect(assetFiles.loadRegisteredRecoveryAssetPayload(base)).rejects.toThrow(
    "exceeds read limit",
  );
  await expect(
    retainRegisteredRecoveryCheckpointImages({
      ...imageOptions(),
      executionMaxBytes: base.executionMaxBytes,
      createValidationDatabase: create,
    }),
  ).rejects.toThrow("exceeds read limit");
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("refuses execution coverage with host manifests before reading files", async () => {
  await registerAssets();
  const open = vi.spyOn(fs, "open");
  const input = { ...options(), history: history() } as unknown as Parameters<
    typeof retainRegisteredRecoveryCheckpointImages
  >[0];
  await expect(retainRegisteredRecoveryCheckpointImages(input)).rejects.toThrow(
    "requires saved manifests",
  );
  expect(open).not.toHaveBeenCalled();
});

it.each(["missing", "local", "shared"])(
  "refuses %s execution source bindings before file opens",
  async (change) => {
    await registerAssets();
    await saveWithoutExecutionCoverage();
    if (change === "missing") await db.run(sql`DELETE FROM local_recovery_executions`);
    if (change === "local")
      await db.run(
        sql`UPDATE local_recovery_executions SET local_descriptor=${JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) })}`,
      );
    if (change === "shared")
      await db.run(
        sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...executions.checkpoint, checkpoint: { ...shared.checkpoint, sha256: "b".repeat(64) } })}`,
      );
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    const base = { ...assetOptions(), createValidationDatabase: create };
    await expect(
      assetFiles.saveRegisteredRecoveryAssetPayload({ ...base, input: assets.payload }),
    ).rejects.toThrow();
    await expect(assetFiles.loadRegisteredRecoveryAssetPayload(base)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["missing", "corrupt", "symlink", "temporary"])(
  "refuses %s saved execution bytes before validation SQL or image reads",
  async (change) => {
    await registerAssets();
    await saveWithoutExecutionCoverage();
    if (change === "missing") await fs.unlink(executionPath());
    if (change === "corrupt") await fs.writeFile(executionPath(), "changed");
    if (change === "symlink") {
      const outside = join(root, "outside");
      await fs.rename(executionPath(), outside);
      await fs.symlink(outside, executionPath());
    }
    if (change === "temporary") await fs.writeFile(executionTemporary(), "partial");
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
  "rechecks the original execution binding after %s source validation",
  async (operation) => {
    await registerAssets();
    if (operation === "load") await save();
    const original = executionFiles.loadRegisteredSharedRecoveryExecutionPayload;
    vi.spyOn(executionFiles, "loadRegisteredSharedRecoveryExecutionPayload").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        await db.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...executions.checkpoint, sha256: "b".repeat(64) })}`,
        );
        return result;
      },
    );
    await expect(operation === "save" ? save() : load()).rejects.toThrow(
      "execution checkpoint binding changed",
    );
    expect(existsSync(assetPath())).toBe(operation === "load");
  },
);

it.each(["save", "load"])(
  "refuses a coherent replacement of all four catalogs before final %s success",
  async (operation) => {
    await registerAssets();
    if (operation === "load") await save();
    const require = recovery.requireRecoveryAssetCheckpoint;
    vi.spyOn(recovery, "requireRecoveryAssetCheckpoint").mockImplementationOnce(async (...args) => {
      const result = await require(...args);
      const nextLocal = { ...local.checkpoint, sha256: "b".repeat(64) },
        nextShared = { ...shared.checkpoint, sha256: "c".repeat(64) };
      await withTx(db, async (tx) => {
        await tx.run(
          sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(nextShared)},local_descriptor=${JSON.stringify(nextLocal)}`,
        );
        await tx.run(
          sql`UPDATE local_recovery_executions SET descriptor=${JSON.stringify({ ...executions.checkpoint, checkpoint: nextShared })},local_descriptor=${JSON.stringify(nextLocal)}`,
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
])("%s rechecks changed execution %s after source validation", async (operation, change) => {
  await registerAssets();
  if (operation === "load") await save();
  let calls = 0;
  const input = {
    ...assetOptions(),
    createValidationDatabase: async () => {
      if (++calls === 3) {
        if (change === "bytes") await fs.writeFile(executionPath(), "changed");
        else await fs.writeFile(executionTemporary(), "partial");
      }
      return factory();
    },
  };
  await expect(
    operation === "save"
      ? assetFiles.saveRegisteredRecoveryAssetPayload({ ...input, input: assets.payload })
      : assetFiles.loadRegisteredRecoveryAssetPayload(input),
  ).rejects.toThrow("executions payload needs review");
  expect(calls).toBe(4);
  expect(
    await fs.readFile(change === "bytes" ? executionPath() : executionTemporary(), "utf8"),
  ).toBe(change === "bytes" ? "changed" : "partial");
});

it("preserves published manifest evidence if execution bytes change during publication", async () => {
  await registerAssets();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    await fs.writeFile(executionPath(), "changed");
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
  "preserves evidence when the final execution-covered %s commit fails",
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

it("commits image protection before reading bytes and retains invocation-only images through cleanup", async () => {
  await registerAssets();
  await save();
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    read = imageEvidence.inspectRetainedImage;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    expect((await inspectAssetManifest(other.db, owner())).record.state).toBe("pending");
    return read(...args);
  });
  try {
    const reserved = await reserve();
    expect(reserved).toMatchObject({
      state: "pending",
      executionBinding: executionBinding(),
      assetCheckpoint: assets.checkpoint,
      manifest: manifest(0, 1, 2, 3, 4, 5, 6),
    });
    await handoff();
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
    const retained = await retain();
    expect(retained).toMatchObject({ state: "retained", executionBinding: executionBinding() });
    const before = (await inspect()).record;
    expect((await retain()).changed).toBe(false);
    expect((await inspect()).record).toEqual(before);
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
  } finally {
    other.close();
  }
});

it("verifies an archived no-op child image without reinstalling it", async () => {
  await registerAssets();
  await save();
  const archive = join(imageDirectory(root), ".retained");
  await fs.mkdir(archive);
  const target = join(archive, uploads[4].filename);
  await fs.rename(file(4), target);
  const before = await fs.readFile(target);
  expect((await retain()).state).toBe("retained");
  expect(existsSync(file(4))).toBe(false);
  expect(await fs.readFile(target)).toEqual(before);
});

it.each(["binding", "file", "temporary"])(
  "refuses changed execution %s after loading and preserves an earlier reservation",
  async (change) => {
    await registerAssets();
    await save();
    await reserve();
    const before = (await inspect()).record,
      original = assetFiles.loadRegisteredRecoveryAssetPayload;
    vi.spyOn(assetFiles, "loadRegisteredRecoveryAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        if (change === "binding") await db.run(sql`DELETE FROM local_recovery_executions`);
        if (change === "file") await fs.unlink(executionPath());
        if (change === "temporary") await fs.writeFile(executionTemporary(), "partial");
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
  "rolls back %s if owner publication changes the execution binding",
  async (phase) => {
    await registerAssets();
    await save();
    if (phase === "reservation")
      await db.run(
        sql`CREATE TRIGGER remove_execution AFTER INSERT ON local_asset_manifest WHEN NEW.owner_kind='recovery' BEGIN DELETE FROM local_recovery_executions; END`,
      );
    else
      await db.run(
        sql`CREATE TRIGGER remove_execution AFTER UPDATE OF state ON local_asset_manifest WHEN NEW.owner_kind='recovery' AND NEW.state='retained' BEGIN DELETE FROM local_recovery_executions; END`,
      );
    await expect(retain()).rejects.toThrow("execution checkpoint binding changed");
    if (phase === "reservation") await expect(inspect()).rejects.toThrow("not found");
    else expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    expect((await db.values(sql`SELECT descriptor FROM local_recovery_executions`))[0][0]).toBe(
      JSON.stringify(executions.checkpoint),
    );
  },
);

it.each(["file", "temporary"])(
  "preserves pending protection if execution %s changes during image verification",
  async (change) => {
    await registerAssets();
    await save();
    const original = imageEvidence.inspectRetainedImage;
    vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (change === "file") await fs.writeFile(executionPath(), "changed");
      else await fs.writeFile(executionTemporary(), "partial");
      return result;
    });
    await expect(retain()).rejects.toThrow("executions payload needs review");
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    await handoff();
    await cleanup();
    expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
  },
);

it.each(["missing-child", "changed-empty"])(
  "preserves protection after %s image verification failure",
  async (change) => {
    await registerAssets();
    await save();
    if (change === "missing-child") await fs.unlink(file(4));
    else await fs.writeFile(file(3), "changed");
    await expect(retain()).rejects.toThrow("Required image");
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
  },
);

it("preserves an earlier retained owner when saved execution evidence disappears", async () => {
  await registerAssets();
  await save();
  await retain();
  const before = (await inspect()).record;
  await fs.unlink(executionPath());
  await expect(retain()).rejects.toThrow();
  expect((await inspect()).record).toEqual(before);
  await handoff();
  await cleanup();
  expect(uploads.every((_, n) => existsSync(file(n)))).toBe(true);
});

it("serializes all four catalog changes, owner release and cleanup during image verification", async () => {
  await registerAssets();
  await save();
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const original = imageEvidence.inspectRetainedImage;
  vi.spyOn(imageEvidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return original(...args);
  });
  const verifying = retain();
  try {
    await entered.promise;
    for (const table of [
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
    await other.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(releaseAssetManifest(other.db, owner(), "Competing release")).rejects.toThrow();
    await other.db.values(sql`PRAGMA busy_timeout=1`);
    await expect(collectUnusedImages(root, other.db)).rejects.toThrow();
    proceed.resolve();
    expect((await verifying).state).toBe("retained");
  } finally {
    proceed.resolve();
    await verifying.catch(() => undefined);
    other.close();
  }
});

it("owns the execution limit, source identity and root before validation callbacks", async () => {
  await registerAssets();
  await save();
  const input = { ...imageOptions(), expected: { ...identity } };
  input.createValidationDatabase = async () => {
    input.executionMaxBytes = 0;
    input.expected.deviceId = "changed";
    input.root = join(root, "elsewhere");
    return factory();
  };
  expect((await retainRegisteredRecoveryCheckpointImages(input)).executionBinding).toEqual(
    executionBinding(),
  );
});

it.each(["reservation", "verification"])(
  "preserves execution-covered protection after %s commit failure",
  async (phase) => {
    await registerAssets();
    await save();
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (work) => withReadTx(db, (tx) => work(tx as unknown as DatabaseHandle)),
      write: (work) =>
        withTx(db, async (tx) => {
          const result = await work(tx);
          const rows = await tx.values(
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
    const before = await catalogs(),
      read = vi.spyOn(imageEvidence, "inspectRetainedImage");
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

it("serializes all four catalog changes during execution-covered manifest publication", async () => {
  await registerAssets();
  const other = await openDb(`file:${join(root, "db.sqlite")}`),
    entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const original = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return original(...args);
  });
  const saving = save();
  try {
    await entered.promise;
    for (const table of [
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
    proceed.resolve();
    expect((await saving).changed).toBe(true);
  } finally {
    proceed.resolve();
    await saving.catch(() => undefined);
    other.close();
  }
});
