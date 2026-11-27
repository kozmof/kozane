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
import {
  captureLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpoint,
  parseSharedRecoveryProjection,
  describeSharedRecoveryHistory,
  rememberSharedRecoveryCheckpoint,
  describeRecoveryAssets,
  rememberRecoveryAssetCheckpoint,
} from "@kozane/core/recovery";
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
import * as sharedPayload from "./shared-recovery-payload.js";
import * as assetPayload from "./recovery-asset-payload.js";
import {
  registeredLocalRecoveryImageOwner,
  reserveRegisteredLocalRecoveryImages,
} from "./local-recovery-images.js";
import {
  reserveRegisteredRecoveryCheckpointImages,
  retainRegisteredRecoveryCheckpointImages,
} from "./recovery-checkpoint-images.js";
import * as evidence from "./image-upload-evidence.js";

let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof describeSharedRecoveryHistory>>;
let assets: Awaited<ReturnType<typeof describeRecoveryAssets>>;
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
const manifest = (...indices: number[]) => ({
  version: 1 as const,
  entries: indices.map((n) => ({
    name: `.kozane/assets/images/${uploads[n].filename}`,
    byteLength: uploads[n].byteLength,
    sha256: uploads[n].sha256,
  })),
});
const history = () => ({
  baseline: { id: "baseline", manifest: manifest(0) },
  effectSets: [
    { id: "edit", manifest: manifest(0, 1, 2) },
    { id: "empty", manifest: manifest(4) },
  ],
});
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  history: history(),
  createValidationDatabase: () => createTestDB(),
});
const file = (n: number) => join(imageDirectory(root), uploads[n].filename);
const localPath = () =>
  join(root, ".kozane", "recovery", "checkpoints", `${local.checkpoint.sha256}.json`);
const sharedPath = () =>
  join(root, ".kozane", "recovery", "shared-history", `${shared.checkpoint.sha256}.json`);
const assetPath = () =>
  join(root, ".kozane", "recovery", "asset-manifests", `${assets.checkpoint.sha256}.json`);
const assetTemporary = () =>
  join(root, ".kozane", "recovery", "asset-manifests", `.pending-${assets.checkpoint.sha256}.json`);
const savedOptions = () => {
  const { history: _history, ...base } = options();
  return { ...base, assetMaxBytes: assets.checkpoint.byteLength };
};
const inspect = () => inspectAssetManifest(db, owner());

beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-checkpoint-images-"));
  db = await createTestDB(join(root, "db.sqlite"));
  uploads = [];
  for (let n = 0; n < 5; n++) {
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
  for (const n of [0, 1, 2, 4])
    await db.run(
      sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${uploads[n].filename}`,
    );
  local = await captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await rememberLocalRecoveryCheckpoint(db, local.checkpoint);
  const row = (n: number) => ({
    id: ["text", "n"] as const,
    name: ["text", `kozane-image:/api/images/${uploads[n].filename}`] as const,
    is_default: ["integer", "0"] as const,
  });
  const baseline = parseSharedRecoveryProjection({
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
    ].map((name) => ({ name, rows: name === "namespace" ? [row(0)] : [] })),
  });
  shared = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: baseline },
      effectSets: [
        {
          id: "edit",
          effects: [
            {
              ord: 0,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "U",
              before: row(0),
              after: row(1),
            },
            {
              ord: 1,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "U",
              before: row(1),
              after: row(2),
            },
            {
              ord: 2,
              table: "namespace",
              key: { id: ["text", "n"] },
              op: "D",
              before: row(2),
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
  await rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  await reserveAssetManifest(db, stage, manifest(0, 1, 2, 4));
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await sharedPayload.saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
  assets = await describeRecoveryAssets({
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    history: history(),
  });
  await rememberRecoveryAssetCheckpoint(db, assets.checkpoint);
  await assetPayload.saveRegisteredRecoveryAssetPayload({
    ...savedOptions(),
    input: assets.payload,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("reserves the union of row-history, invocation and local requirements without reading image bytes", async () => {
  expect(shared.projection.tables.every(({ rows }) => rows.length === 0)).toBe(true);
  const read = vi.spyOn(evidence, "inspectRetainedImage");
  const result = await reserveRegisteredRecoveryCheckpointImages(options());
  expect(result).toEqual({
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    owner: owner(),
    manifest: mergeAssetManifests([manifest(0, 1, 2, 3, 4)]),
    state: "pending",
    changed: true,
  });
  expect(read).not.toHaveBeenCalled();
  const original = (await inspect()).record;
  expect((await reserveRegisteredRecoveryCheckpointImages(options())).changed).toBe(false);
  expect((await inspect()).record).toEqual(original);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.manifest.entries[0])).toBe(true);
});

it("commits protection before byte verification and preserves timestamps on successful retry", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  const read = evidence.inspectRetainedImage;
  vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    expect((await inspectAssetManifest(other.db, owner())).record.state).toBe("pending");
    return read(...args);
  });
  try {
    expect((await retainRegisteredRecoveryCheckpointImages(options())).state).toBe("retained");
  } finally {
    other.close();
  }
  const original = (await inspect()).record;
  expect(original.verifiedAt).toBeInstanceOf(Date);
  expect((await retainRegisteredRecoveryCheckpointImages(options())).changed).toBe(false);
  expect((await inspect()).record).toEqual(original);
});

async function handoff() {
  await abandonImageUpload(db, uploads[3].filename, "Retained by checkpoint", true);
  await releaseAssetManifest(db, stage, "Retained by checkpoint");
  const queue = join(imageDirectory(root), ".pending-delete");
  await fs.mkdir(queue, { recursive: true });
  for (let n = 0; n < 5; n++) {
    await fs.writeFile(join(queue, uploads[n].filename), "");
    if (existsSync(file(n))) await fs.utimes(file(n), new Date(0), new Date(0));
  }
}
async function cleanup() {
  await collectUnusedImages(root, db);
  await retryImageDeletions(root, db);
}
it("protects deleted, intermediate, invocation-only and local images after prior pins release", async () => {
  await reserveRegisteredRecoveryCheckpointImages(options());
  await handoff();
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
  await retainRegisteredRecoveryCheckpointImages(options());
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
  await releaseAssetManifest(db, owner(), "Checkpoint retired");
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => !existsSync(file(n)))).toBe(true);
  await expect(retainRegisteredRecoveryCheckpointImages(options())).rejects.toThrow(
    "cannot be reused",
  );
});

it.each(["baseline", "intermediate", "before-image"])(
  "refuses omitted %s row-image coverage before reserving protection",
  async (missing) => {
    const input = options();
    if (missing === "baseline") input.history.baseline.manifest = manifest();
    if (missing === "intermediate") input.history.effectSets[0].manifest = manifest(0, 2);
    if (missing === "before-image") input.history.effectSets[0].manifest = manifest(1, 2);
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(retainRegisteredRecoveryCheckpointImages(input)).rejects.toThrow(
      "Required asset is missing",
    );
    await expect(inspect()).rejects.toThrow("not found");
    expect(read).not.toHaveBeenCalled();
  },
);

it("refuses a conflicting inactive local image identity before reservation", async () => {
  const input = options();
  input.history.effectSets[1].manifest.entries[0].sha256 = "b".repeat(64);
  await expect(retainRegisteredRecoveryCheckpointImages(input)).rejects.toThrow(
    "Conflicting asset bytes",
  );
  await expect(inspect()).rejects.toThrow("not found");
});

it.each(["local", "shared", "local-temporary", "shared-temporary"])(
  "refuses missing or incomplete %s payloads before reserving images",
  async (state) => {
    if (state === "local") await fs.unlink(localPath());
    if (state === "shared") await fs.unlink(sharedPath());
    if (state === "local-temporary")
      await fs.writeFile(
        join(
          root,
          ".kozane",
          "recovery",
          "checkpoints",
          `.pending-${local.checkpoint.sha256}.json`,
        ),
        "partial",
      );
    if (state === "shared-temporary")
      await fs.writeFile(
        join(
          root,
          ".kozane",
          "recovery",
          "shared-history",
          `.pending-${shared.checkpoint.sha256}.json`,
        ),
        "partial",
      );
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(retainRegisteredRecoveryCheckpointImages(options())).rejects.toThrow();
    await expect(inspect()).rejects.toThrow("not found");
    expect(read).not.toHaveBeenCalled();
  },
);

it.each(["localMaxBytes", "sharedMaxBytes"] as const)(
  "enforces the independent %s payload limit",
  async (field) => {
    const input = options();
    input[field]--;
    await expect(reserveRegisteredRecoveryCheckpointImages(input)).rejects.toThrow(
      "exceeds read limit",
    );
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it.each(["missing-intermediate", "missing-extra", "changed-local"])(
  "preserves pending protection after %s bytes refuse verification",
  async (failure) => {
    if (failure === "missing-intermediate") await fs.unlink(file(1));
    if (failure === "missing-extra") await fs.unlink(file(4));
    if (failure === "changed-local") await fs.writeFile(file(3), "changed");
    await expect(retainRegisteredRecoveryCheckpointImages(options())).rejects.toThrow(
      "Required image",
    );
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    await handoff();
    await cleanup();
    expect(existsSync(file(0))).toBe(true);
    expect(existsSync(file(2))).toBe(true);
  },
);

it("verifies archived invocation-only bytes without reinstalling them", async () => {
  const archive = join(imageDirectory(root), ".retained");
  await fs.mkdir(archive);
  const path = join(archive, uploads[4].filename);
  await fs.rename(file(4), path);
  const before = await fs.readFile(path);
  expect((await retainRegisteredRecoveryCheckpointImages(options())).state).toBe("retained");
  expect(existsSync(file(4))).toBe(false);
  expect(await fs.readFile(path)).toEqual(before);
});

it("rechecks retained images and preserves earlier protection after a failed verification", async () => {
  await retainRegisteredRecoveryCheckpointImages(options());
  const before = (await inspect()).record;
  await fs.writeFile(file(1), "changed");
  await expect(retainRegisteredRecoveryCheckpointImages(options())).rejects.toThrow(
    "Required image",
  );
  expect((await inspect()).record).toEqual(before);
});

it("shares the stable owner with earlier valid local-checkpoint reservations", async () => {
  await reserveRegisteredLocalRecoveryImages({
    ...options(),
    maxBytes: local.checkpoint.byteLength,
  });
  const original = (await inspect()).record;
  expect((await reserveRegisteredRecoveryCheckpointImages(options())).changed).toBe(false);
  expect((await inspect()).record).toEqual(original);
});

it("copies manifest inputs before asynchronous payload validation", async () => {
  const input = options();
  input.createValidationDatabase = async () => {
    input.history.baseline.id = "changed";
    input.history.effectSets.reverse();
    return createTestDB();
  };
  expect((await retainRegisteredRecoveryCheckpointImages(input)).state).toBe("retained");
});

it("rechecks original catalog bindings before committing a reservation", async () => {
  const load = sharedPayload.loadRegisteredSharedRecoveryPayload;
  vi.spyOn(sharedPayload, "loadRegisteredSharedRecoveryPayload").mockImplementationOnce(
    async (...args) => {
      const result = await load(...args);
      const changed = JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) });
      await db.run(sql`UPDATE local_recovery_checkpoint SET descriptor=${changed}`);
      await db.run(sql`UPDATE local_recovery_shared_history SET local_descriptor=${changed}`);
      return result;
    },
  );
  await expect(retainRegisteredRecoveryCheckpointImages(options())).rejects.toThrow(
    "binding changed",
  );
  await expect(inspect()).rejects.toThrow("not found");
});

it.each(["local", "shared"])(
  "keeps committed protection if the %s payload changes while image bytes are verified",
  async (area) => {
    const read = evidence.inspectRetainedImage;
    vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      await fs.writeFile(area === "local" ? localPath() : sharedPath(), "changed");
      return result;
    });
    await expect(retainRegisteredRecoveryCheckpointImages(options())).rejects.toThrow(
      "payload needs review",
    );
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    await handoff();
    await cleanup();
    expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
  },
);

it.each(["reservation", "verification"])(
  "preserves earlier durable state after %s commit failure",
  async (phase) => {
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (operation) => withReadTx(db, (tx) => operation(tx as unknown as DatabaseHandle)),
      write: (operation) =>
        withTx(db, async (tx) => {
          const result = await operation(tx);
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
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(
      retainRegisteredRecoveryCheckpointImages({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    if (phase === "reservation") {
      await expect(inspect()).rejects.toThrow("not found");
      expect(read).not.toHaveBeenCalled();
    } else {
      expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
      expect(read).toHaveBeenCalledTimes(5);
    }
    expect((await retainRegisteredRecoveryCheckpointImages(options())).state).toBe("retained");
  },
);

it("serializes cleanup and owner release throughout image verification", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const read = evidence.inspectRetainedImage;
  vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return read(...args);
  });
  const verifying = retainRegisteredRecoveryCheckpointImages(options());
  try {
    await entered.promise;
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

it("reserves saved manifest requirements without reading image bytes or receiving host history", async () => {
  const read = vi.spyOn(evidence, "inspectRetainedImage");
  const result = await reserveRegisteredRecoveryCheckpointImages(savedOptions());
  expect(result).toEqual({
    binding: assets.checkpoint.binding,
    assetCheckpoint: assets.checkpoint,
    owner: owner(),
    manifest: assets.payload.manifest,
    state: "pending",
    changed: true,
  });
  expect(result.manifest).toEqual(mergeAssetManifests([manifest(0, 1, 2, 3, 4)]));
  expect(read).not.toHaveBeenCalled();
  expect(Object.isFrozen(result.assetCheckpoint!.binding.localCheckpoint)).toBe(true);
  const before = (await inspect()).record;
  expect((await reserveRegisteredRecoveryCheckpointImages(savedOptions())).changed).toBe(false);
  expect((await inspect()).record).toEqual(before);
});

it("commits saved-manifest protection before the first image read and rechecks bytes on retry", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  const read = evidence.inspectRetainedImage;
  const reader = vi
    .spyOn(evidence, "inspectRetainedImage")
    .mockImplementationOnce(async (...args) => {
      expect((await inspectAssetManifest(other.db, owner())).record.state).toBe("pending");
      return read(...args);
    });
  try {
    expect((await retainRegisteredRecoveryCheckpointImages(savedOptions())).state).toBe("retained");
  } finally {
    other.close();
  }
  const before = (await inspect()).record;
  expect(reader).toHaveBeenCalledTimes(5);
  expect((await retainRegisteredRecoveryCheckpointImages(savedOptions())).changed).toBe(false);
  expect(reader).toHaveBeenCalledTimes(10);
  expect((await inspect()).record).toEqual(before);
});

it("protects all saved requirements through cleanup until explicit checkpoint retirement", async () => {
  await reserveRegisteredRecoveryCheckpointImages(savedOptions());
  await handoff();
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
  await retainRegisteredRecoveryCheckpointImages(savedOptions());
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
  await releaseAssetManifest(db, owner(), "Checkpoint retired");
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => !existsSync(file(n)))).toBe(true);
  await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
    "cannot be reused",
  );
});

it("reuses an exact earlier host reservation without replacing its owner or timestamps", async () => {
  await reserveRegisteredRecoveryCheckpointImages(options());
  const before = (await inspect()).record;
  expect((await reserveRegisteredRecoveryCheckpointImages(savedOptions())).changed).toBe(false);
  expect((await inspect()).record).toEqual(before);
});

it("refuses a different earlier owner manifest while keeping its protection intact", async () => {
  await reserveAssetManifest(db, owner(), manifest(0));
  const before = (await inspect()).record;
  await expect(reserveRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
    "different asset manifest",
  );
  expect((await inspect()).record).toEqual(before);
});

it("keeps the host-manifest workflow available without a saved asset payload", async () => {
  await fs.unlink(assetPath());
  await db.run(sql`DELETE FROM local_recovery_assets`);
  expect((await reserveRegisteredRecoveryCheckpointImages(options())).state).toBe("pending");
});

it("refuses ambiguous host and saved manifest inputs before image work", async () => {
  const read = vi.spyOn(evidence, "inspectRetainedImage");
  await expect(
    reserveRegisteredRecoveryCheckpointImages({ ...savedOptions(), history: history() } as never),
  ).rejects.toThrow("Choose saved manifests or host history");
  expect(read).not.toHaveBeenCalled();
  await expect(inspect()).rejects.toThrow("not found");
});

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid saved manifest limit %s",
  async (assetMaxBytes) => {
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(
      reserveRegisteredRecoveryCheckpointImages({ ...savedOptions(), assetMaxBytes }),
    ).rejects.toThrow("positive safe integer");
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it.each(["assetMaxBytes", "localMaxBytes", "sharedMaxBytes"] as const)(
  "enforces the saved workflow's independent %s limit before reservation",
  async (field) => {
    const input = savedOptions();
    input[field]--;
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(reserveRegisteredRecoveryCheckpointImages(input)).rejects.toThrow(
      "exceeds read limit",
    );
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it.each(["missing-file", "corrupt-file", "temporary", "symlink", "missing-catalog"])(
  "refuses %s asset evidence before creating protection",
  async (change) => {
    if (change === "missing-file") await fs.unlink(assetPath());
    if (change === "corrupt-file") await fs.writeFile(assetPath(), "changed");
    if (change === "temporary") await fs.writeFile(assetTemporary(), "partial");
    if (change === "symlink") {
      const outside = join(root, "outside");
      await fs.rename(assetPath(), outside);
      await fs.symlink(outside, assetPath());
    }
    if (change === "missing-catalog") await db.run(sql`DELETE FROM local_recovery_assets`);
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it("refuses changed per-record requirements even if their combined manifest stays identical", async () => {
  const changed = JSON.parse(JSON.stringify(assets.payload));
  changed.history.baseline.manifest = mergeAssetManifests([manifest(0, 4)]);
  changed.history.effectSets[1].manifest = manifest();
  expect(changed.manifest).toEqual(assets.payload.manifest);
  await fs.writeFile(assetPath(), JSON.stringify(changed));
  await expect(reserveRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow();
  await expect(inspect()).rejects.toThrow("not found");
});

it.each(["missing-intermediate", "missing-invocation", "changed-local"])(
  "preserves saved-manifest pins after %s image verification fails",
  async (change) => {
    if (change === "missing-intermediate") await fs.unlink(file(1));
    if (change === "missing-invocation") await fs.unlink(file(4));
    if (change === "changed-local") await fs.writeFile(file(3), "changed");
    await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
      "Required image",
    );
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    await handoff();
    await cleanup();
    expect(existsSync(file(0))).toBe(true);
    expect(existsSync(file(2))).toBe(true);
  },
);

it("verifies saved invocation-only archived bytes without reinstalling them", async () => {
  const directory = join(imageDirectory(root), ".retained");
  await fs.mkdir(directory);
  const archive = join(directory, uploads[4].filename);
  await fs.rename(file(4), archive);
  const before = await fs.readFile(archive);
  expect((await retainRegisteredRecoveryCheckpointImages(savedOptions())).state).toBe("retained");
  expect(existsSync(file(4))).toBe(false);
  expect(await fs.readFile(archive)).toEqual(before);
});

it("preserves earlier retained protection when a saved-manifest recheck fails", async () => {
  await retainRegisteredRecoveryCheckpointImages(savedOptions());
  const before = (await inspect()).record;
  await fs.writeFile(file(4), "changed");
  await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
    "Required image",
  );
  expect((await inspect()).record).toEqual(before);
});

it.each(["local", "shared", "assets", "asset-temporary"])(
  "preserves pending protection if %s bytes change during image verification",
  async (area) => {
    const read = evidence.inspectRetainedImage;
    vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      if (area === "asset-temporary") await fs.writeFile(assetTemporary(), "partial");
      else
        await fs.writeFile(
          area === "local" ? localPath() : area === "shared" ? sharedPath() : assetPath(),
          "changed",
        );
      return result;
    });
    await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
      "payload needs review",
    );
    expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
    await handoff();
    await cleanup();
    expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
  },
);

it.each(["assets", "local", "shared"])(
  "rechecks the original %s catalog after loading saved manifests",
  async (which) => {
    const load = assetPayload.loadRegisteredRecoveryAssetPayload;
    vi.spyOn(assetPayload, "loadRegisteredRecoveryAssetPayload").mockImplementationOnce(
      async (...args) => {
        const result = await load(...args);
        if (which === "assets")
          await db.run(
            sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...assets.checkpoint, sha256: "b".repeat(64) })}`,
          );
        if (which === "local")
          await db.run(
            sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify({ ...local.checkpoint, sha256: "b".repeat(64) })}`,
          );
        if (which === "shared")
          await db.run(
            sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify({ ...shared.checkpoint, sha256: "b".repeat(64) })}`,
          );
        return result;
      },
    );
    await expect(reserveRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
      "binding changed",
    );
    await expect(inspect()).rejects.toThrow("not found");
  },
);

it("rechecks manifest bytes after loading and before committing the reservation", async () => {
  const load = assetPayload.loadRegisteredRecoveryAssetPayload;
  vi.spyOn(assetPayload, "loadRegisteredRecoveryAssetPayload").mockImplementationOnce(
    async (...args) => {
      const result = await load(...args);
      await fs.unlink(assetPath());
      return result;
    },
  );
  await expect(reserveRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
    "payload needs review",
  );
  await expect(inspect()).rejects.toThrow("not found");
});

it("rolls back a new reservation if its asset binding changes during owner publication", async () => {
  await db.run(
    sql`CREATE TRIGGER remove_binding AFTER INSERT ON local_asset_manifest WHEN NEW.owner_kind='recovery' BEGIN DELETE FROM local_recovery_assets; END`,
  );
  await expect(reserveRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
    "asset checkpoint binding changed",
  );
  await expect(inspect()).rejects.toThrow("not found");
  expect((await db.values(sql`SELECT descriptor FROM local_recovery_assets`))[0][0]).toBe(
    JSON.stringify(assets.checkpoint),
  );
});

it.each(["reservation", "verification"])(
  "preserves saved-manifest protection after %s commit failure",
  async (phase) => {
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (operation) => withReadTx(db, (tx) => operation(tx as unknown as DatabaseHandle)),
      write: (operation) =>
        withTx(db, async (tx) => {
          const result = await operation(tx);
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
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(
      retainRegisteredRecoveryCheckpointImages({ ...savedOptions(), db: wrapped }),
    ).rejects.toThrow();
    if (phase === "reservation") {
      await expect(inspect()).rejects.toThrow("not found");
      expect(read).not.toHaveBeenCalled();
    } else {
      expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
      expect(read).toHaveBeenCalledTimes(5);
    }
    expect((await retainRegisteredRecoveryCheckpointImages(savedOptions())).state).toBe("retained");
  },
);

it("serializes catalog changes, owner release and cleanup while saved images are verified", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const read = evidence.inspectRetainedImage;
  vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return read(...args);
  });
  const verifying = retainRegisteredRecoveryCheckpointImages(savedOptions());
  try {
    await entered.promise;
    for (const table of [
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

it("owns saved workflow identity, root and byte limits before validation callbacks", async () => {
  const input = { ...savedOptions(), expected: { ...identity } };
  input.createValidationDatabase = async () => {
    input.expected.deviceId = "changed";
    input.root = join(root, "elsewhere");
    input.assetMaxBytes = 0;
    input.localMaxBytes = 0;
    input.sharedMaxBytes = 0;
    return createTestDB();
  };
  expect((await retainRegisteredRecoveryCheckpointImages(input)).assetCheckpoint).toEqual(
    assets.checkpoint,
  );
  expect((await inspect()).record.state).toBe("retained");
});

it("preserves retained protection if its saved manifest later disappears", async () => {
  await retainRegisteredRecoveryCheckpointImages(savedOptions());
  const before = (await inspect()).record;
  await fs.unlink(assetPath());
  await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow();
  expect((await inspect()).record).toEqual(before);
  await handoff();
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
});

it("rolls back verification if publishing the retained owner changes its asset binding", async () => {
  await db.run(
    sql`CREATE TRIGGER remove_verified_binding AFTER UPDATE OF state ON local_asset_manifest WHEN NEW.owner_kind='recovery' AND NEW.state='retained' BEGIN DELETE FROM local_recovery_assets; END`,
  );
  await expect(retainRegisteredRecoveryCheckpointImages(savedOptions())).rejects.toThrow(
    "asset checkpoint binding changed",
  );
  expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
  expect((await db.values(sql`SELECT descriptor FROM local_recovery_assets`))[0][0]).toBe(
    JSON.stringify(assets.checkpoint),
  );
  await handoff();
  await cleanup();
  expect([0, 1, 2, 3, 4].every((n) => existsSync(file(n)))).toBe(true);
});
