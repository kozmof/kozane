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
