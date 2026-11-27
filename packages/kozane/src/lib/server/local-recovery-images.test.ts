import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { migrations } from "@kozane/core/migrations";
import { mergeAssetManifests } from "@kozane/core";
import {
  captureLocalRecoveryCheckpoint,
  rememberLocalRecoveryCheckpoint,
} from "@kozane/core/recovery";
import {
  createDatabaseAdapter,
  withTx,
  withReadTx,
  type DatabaseHandle,
} from "../../db/database.js";
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
import * as evidence from "./image-upload-evidence.js";
import * as payload from "./local-recovery-payload.js";
import {
  reserveRegisteredLocalRecoveryImages,
  retainRegisteredLocalRecoveryImages,
  registeredLocalRecoveryImageOwner,
} from "./local-recovery-images.js";

let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let captured: Awaited<ReturnType<typeof captureLocalRecoveryCheckpoint>>;
let uploads: (typeof localImageUploadTable.$inferSelect)[];
const identity = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const owner = () => registeredLocalRecoveryImageOwner(identity);
const transfer = { kind: "transfer" as const, id: "incoming" };
const manifest = (...indices: number[]) => ({
  version: 1 as const,
  entries: indices.map((index) => ({
    name: `.kozane/assets/images/${uploads[index].filename}`,
    byteLength: uploads[index].byteLength,
    sha256: uploads[index].sha256,
  })),
});
const history = () => ({
  baseline: { id: "baseline", manifest: manifest(2) },
  effectSets: [
    { id: "first", manifest: manifest(3) },
    { id: "second", manifest: manifest() },
  ],
});
const options = () => ({
  root,
  db,
  expected: identity,
  maxBytes: captured.checkpoint.byteLength,
  createValidationDatabase: () => createTestDB(),
  history: history(),
});
const file = (index: number) => join(imageDirectory(root), uploads[index].filename);
const published = () =>
  join(root, ".kozane", "recovery", "checkpoints", `${captured.checkpoint.sha256}.json`);
const inspect = () => inspectAssetManifest(db, owner());

beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-recovery-images-"));
  db = await createTestDB(join(root, "db.sqlite"));
  uploads = [];
  for (let index = 0; index < 5; index++) {
    const url = await storeImage(
      root,
      db,
      "image.svg",
      new TextEncoder().encode(`<svg><text>${index}</text></svg>`),
    );
    const filename = url.split("/").pop()!;
    uploads.push(
      (await db.select().from(localImageUploadTable)).find((row) => row.filename === filename)!,
    );
  }
  for (const upload of uploads.slice(1, 4))
    await db.run(
      sql`UPDATE local_image_upload SET state='completed',completed_at=1 WHERE filename=${upload.filename}`,
    );
  await abandonImageUpload(db, uploads[4].filename, "Not required", true);
  await fs.unlink(file(4));
  await reserveAssetManifest(db, transfer, manifest(1));
  captured = await captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["first", "second"],
  }));
  await rememberLocalRecoveryCheckpoint(db, captured.checkpoint);
  await payload.saveRegisteredLocalRecoveryPayload({
    ...options(),
    input: captured.snapshot,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("commits an idempotent checkpoint owner without reading image bytes", async () => {
  const read = vi.spyOn(evidence, "inspectRetainedImage");
  const before = await fs.readFile(published());
  const reserved = await reserveRegisteredLocalRecoveryImages(options());
  expect(reserved).toEqual({
    checkpoint: captured.checkpoint,
    owner: owner(),
    manifest: mergeAssetManifests([manifest(0, 1, 2, 3)]),
    state: "pending",
    changed: true,
  });
  expect(Object.isFrozen(reserved)).toBe(true);
  expect(Object.isFrozen(reserved.manifest.entries[0])).toBe(true);
  expect(read).not.toHaveBeenCalled();
  const connection = await openDb(`file:${join(root, "db.sqlite")}`);
  try {
    expect((await inspectAssetManifest(connection.db, reserved.owner)).record.state).toBe(
      "pending",
    );
  } finally {
    connection.close();
  }
  const original = (await inspect()).record;
  expect(await reserveRegisteredLocalRecoveryImages(options())).toEqual({
    ...reserved,
    changed: false,
  });
  expect((await inspect()).record).toEqual(original);
  expect(await fs.readFile(published())).toEqual(before);
});

it("commits pending protection before verification and preserves retained timestamps on retry", async () => {
  const read = evidence.inspectRetainedImage;
  const connection = await openDb(`file:${join(root, "db.sqlite")}`);
  vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    expect((await inspectAssetManifest(connection.db, owner())).record.state).toBe("pending");
    return read(...args);
  });
  try {
    expect(await retainRegisteredLocalRecoveryImages(options())).toMatchObject({
      owner: owner(),
      state: "retained",
      changed: true,
    });
  } finally {
    connection.close();
  }
  const original = (await inspect()).record;
  expect(original.verifiedAt).toBeInstanceOf(Date);
  expect((await retainRegisteredLocalRecoveryImages(options())).changed).toBe(false);
  expect((await inspect()).record).toEqual(original);
});

it("rechecks retained bytes and preserves earlier protection after a failed recheck", async () => {
  await retainRegisteredLocalRecoveryImages(options());
  const original = (await inspect()).record;
  await fs.writeFile(file(0), "changed after verification");
  await expect(retainRegisteredLocalRecoveryImages(options())).rejects.toThrow("Required image");
  expect((await inspect()).record).toEqual(original);
  await cleanup();
  expect([1, 2, 3].every((index) => existsSync(file(index)))).toBe(true);
});

it("verifies archived checkpoint images without copying them back", async () => {
  await reserveRegisteredLocalRecoveryImages(options());
  const archive = join(imageDirectory(root), ".retained");
  await fs.mkdir(archive);
  const saved = join(archive, uploads[2].filename);
  await fs.rename(file(2), saved);
  const original = await fs.readFile(saved);
  expect((await retainRegisteredLocalRecoveryImages(options())).state).toBe("retained");
  expect(existsSync(file(2))).toBe(false);
  expect(await fs.readFile(saved)).toEqual(original);
});

async function handoff() {
  await abandonImageUpload(db, uploads[0].filename, "Retained by checkpoint", true);
  await releaseAssetManifest(db, transfer, "Retained by checkpoint");
  const queue = join(imageDirectory(root), ".pending-delete");
  await fs.mkdir(queue, { recursive: true });
  for (let index = 0; index < 4; index++) {
    await fs.writeFile(join(queue, uploads[index].filename), "");
    if (existsSync(file(index))) await fs.utimes(file(index), new Date(0), new Date(0));
  }
}
async function cleanup() {
  await collectUnusedImages(root, db);
  await retryImageDeletions(root, db);
}
it("protects snapshot and selected-history images after earlier pins release", async () => {
  await reserveRegisteredLocalRecoveryImages(options());
  await handoff();
  await cleanup();
  expect([0, 1, 2, 3].every((index) => existsSync(file(index)))).toBe(true);
  await retainRegisteredLocalRecoveryImages(options());
  await cleanup();
  expect([0, 1, 2, 3].every((index) => existsSync(file(index)))).toBe(true);
  await releaseAssetManifest(db, owner(), "Checkpoint retired");
  await cleanup();
  expect([0, 1, 2, 3].every((index) => !existsSync(file(index)))).toBe(true);
  await expect(retainRegisteredLocalRecoveryImages(options())).rejects.toThrow("cannot be reused");
});

it.each(["missing", "changed"])(
  "preserves committed pending protection after %s bytes",
  async (failure) => {
    if (failure === "missing") await fs.unlink(file(0));
    else await fs.writeFile(file(0), "changed");
    await expect(retainRegisteredLocalRecoveryImages(options())).rejects.toThrow("Required image");
    const pending = (await inspect()).record;
    expect(pending.state).toBe("pending");
    expect(pending.verifiedAt).toBeNull();
    await handoff();
    await cleanup();
    expect([1, 2, 3].every((index) => existsSync(file(index)))).toBe(true);
    expect((await inspect()).record).toEqual(pending);
  },
);

it.each(["baseline", "missing", "extra", "reordered", "duplicate"])(
  "refuses %s history selections before reservation or image reads",
  async (change) => {
    const input = options();
    if (change === "baseline") input.history.baseline.id = "other";
    if (change === "missing") input.history.effectSets.pop();
    if (change === "extra") input.history.effectSets.push({ id: "extra", manifest: manifest() });
    if (change === "reordered") input.history.effectSets.reverse();
    if (change === "duplicate") input.history.effectSets[1].id = "first";
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(retainRegisteredLocalRecoveryImages(input)).rejects.toThrow(
      "checkpoint selection",
    );
    await expect(inspect()).rejects.toThrow("not found");
    expect(read).not.toHaveBeenCalled();
  },
);

it("refuses name conflicts with inactive snapshot identities before reservation", async () => {
  const input = options();
  input.history.baseline.manifest = manifest(4);
  input.history.baseline.manifest.entries[0].sha256 = "a".repeat(64);
  const read = vi.spyOn(evidence, "inspectRetainedImage");
  await expect(retainRegisteredLocalRecoveryImages(input)).rejects.toThrow(
    "Conflicting asset bytes",
  );
  await expect(inspect()).rejects.toThrow("not found");
  expect(read).not.toHaveBeenCalled();
});

it("refuses changed requirements under the same checkpoint owner", async () => {
  await reserveRegisteredLocalRecoveryImages(options());
  const original = (await inspect()).record;
  const input = options();
  input.history.baseline.manifest = manifest(2, 4);
  await expect(retainRegisteredLocalRecoveryImages(input)).rejects.toThrow(
    "different asset manifest",
  );
  expect((await inspect()).record).toEqual(original);
});

it.each(["missing-catalog", "missing-payload", "temporary"])(
  "does not reserve images after %s payload validation failure",
  async (failure) => {
    if (failure === "missing-catalog") await db.run(sql`DELETE FROM local_recovery_checkpoint`);
    if (failure === "missing-payload") await fs.unlink(published());
    if (failure === "temporary")
      await fs.writeFile(
        join(
          root,
          ".kozane",
          "recovery",
          "checkpoints",
          `.pending-${captured.checkpoint.sha256}.json`,
        ),
        "interrupted",
      );
    const read = vi.spyOn(evidence, "inspectRetainedImage");
    await expect(retainRegisteredLocalRecoveryImages(options())).rejects.toThrow();
    await expect(inspect()).rejects.toThrow("not found");
    expect(read).not.toHaveBeenCalled();
  },
);

it("copies host history before asynchronous validation", async () => {
  const input = options();
  input.createValidationDatabase = async () => {
    input.history.baseline.id = "changed";
    input.history.effectSets.reverse();
    input.history.baseline.manifest.entries[0].sha256 = "a".repeat(64);
    return createTestDB();
  };
  expect((await retainRegisteredLocalRecoveryImages(input)).state).toBe("retained");
  expect((await inspect()).manifest).toEqual(mergeAssetManifests([manifest(0, 1, 2, 3)]));
});

it("rejects accessor history without invoking it or reading payloads", async () => {
  const input = options();
  const getter = vi.fn(() => history().baseline);
  Object.defineProperty(input.history, "baseline", { enumerable: true, get: getter });
  const load = vi.spyOn(payload, "loadRegisteredLocalRecoveryPayload");
  await expect(reserveRegisteredLocalRecoveryImages(input)).rejects.toThrow("plain data");
  expect(getter).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it("refuses sparse history lists before payload reads", async () => {
  const input = options();
  input.history = { ...input.history, effectSets: new Array(2) };
  const load = vi.spyOn(payload, "loadRegisteredLocalRecoveryPayload");
  await expect(reserveRegisteredLocalRecoveryImages(input)).rejects.toThrow("image list");
  expect(load).not.toHaveBeenCalled();
});

it("rechecks the catalog after loading and before committing a reservation", async () => {
  const load = payload.loadRegisteredLocalRecoveryPayload;
  vi.spyOn(payload, "loadRegisteredLocalRecoveryPayload").mockImplementationOnce(
    async (...args) => {
      const loaded = await load(...args);
      await db.run(sql`DELETE FROM local_recovery_checkpoint`);
      return loaded;
    },
  );
  await expect(retainRegisteredLocalRecoveryImages(options())).rejects.toThrow("binding changed");
  await expect(inspect()).rejects.toThrow("not found");
});

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
    const before = await fs.readFile(published());
    await expect(
      retainRegisteredLocalRecoveryImages({ ...options(), db: wrapped }),
    ).rejects.toThrow();
    if (phase === "reservation") {
      await expect(inspect()).rejects.toThrow("not found");
      expect(read).not.toHaveBeenCalled();
    } else {
      expect((await inspect()).record).toMatchObject({ state: "pending", verifiedAt: null });
      expect(read).toHaveBeenCalledTimes(4);
    }
    expect(await fs.readFile(published())).toEqual(before);
    expect([0, 1, 2, 3].every((index) => existsSync(file(index)))).toBe(true);
    expect((await retainRegisteredLocalRecoveryImages(options())).state).toBe("retained");
  },
);

it("serializes competing release and catalog removal during image verification", async () => {
  const connection = await openDb(`file:${join(root, "db.sqlite")}`);
  await connection.db.values(sql`PRAGMA busy_timeout=1`);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const read = evidence.inspectRetainedImage;
  vi.spyOn(evidence, "inspectRetainedImage").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return read(...args);
  });
  const retaining = retainRegisteredLocalRecoveryImages(options());
  try {
    await entered.promise;
    await expect(
      releaseAssetManifest(connection.db, owner(), "Competing release"),
    ).rejects.toThrow();
    await expect(
      withTx(connection.db, (tx) => tx.run(sql`DELETE FROM local_recovery_checkpoint`)),
    ).rejects.toThrow();
    proceed.resolve();
    expect((await retaining).state).toBe("retained");
  } finally {
    proceed.resolve();
    await retaining.catch(() => undefined);
    connection.close();
  }
});

it("derives distinct opaque owners for each catalog identity", () => {
  const keys = ["workspaceId", "deviceId", "epochId", "checkpointId"] as const;
  const owners = [
    owner(),
    ...keys.map((key) => registeredLocalRecoveryImageOwner({ ...identity, [key]: "other/🪁" })),
  ];
  expect(new Set(owners.map((entry) => entry.id)).size).toBe(5);
  expect(owners.every((entry) => /^local-checkpoint-v1:[a-f0-9]{64}$/.test(entry.id))).toBe(true);
});
