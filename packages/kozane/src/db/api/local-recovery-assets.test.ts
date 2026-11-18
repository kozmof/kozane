import { expect, it, vi } from "vitest";
import { createTestDB } from "../../test-utils/db.js";
import type { DB } from "../../../../core/src/database.js";
import { migrations } from "../../../../core/src/generated/migrations.js";
import { IMAGE_MAX_BYTES } from "../../../../core/src/images.js";
import {
  captureLocalRecoverySnapshot,
  type LocalRecoverySnapshot,
} from "../../../../core/src/actions/local-recovery.js";
import { localRecoveryAssetManifest } from "../../../../core/src/actions/local-recovery-assets.js";
import { validateLocalRecoverySnapshot } from "../../../../core/src/actions/local-recovery-validation.js";
import type { TaggedRow, TaggedValue } from "../../../../core/src/actions/row-codec.js";
const keys = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const entry = (n: number, hash = "a".repeat(64)) => ({
  name: `.kozane/assets/images/${filename(n)}`,
  byteLength: 3,
  sha256: hash,
});
const manifest = (...numbers: number[]) => ({ version: 1, entries: numbers.map((n) => entry(n)) });
function upload(
  n: number,
  state: "pending" | "installed" | "completed" | "abandoned" = "pending",
): TaggedRow {
  return {
    filename: ["text", filename(n)],
    byte_length: ["integer", "3"],
    sha256: ["text", "a".repeat(64)],
    state: ["text", state],
    created_at: ["integer", "9007199254740993"],
    installed_at: state === "installed" || state === "completed" ? ["integer", "1"] : ["null"],
    completed_at: state === "completed" ? ["integer", "2"] : ["null"],
    error: ["null"],
    abandoned_at: state === "abandoned" ? ["integer", "3"] : ["null"],
    abandon_reason: state === "abandoned" ? ["text", "Reviewed"] : ["null"],
  };
}
function owner(
  n: number,
  state: "pending" | "retained" | "released" = "pending",
  kind = "recovery",
): TaggedRow {
  return {
    owner_kind: ["text", kind],
    owner_id: ["text", `${state}-${n}`],
    manifest: ["text", JSON.stringify(manifest(n))],
    state: ["text", state],
    created_at: ["integer", "9007199254740993"],
    verified_at: state === "retained" ? ["integer", "1"] : ["null"],
    released_at: state === "released" ? ["integer", "2"] : ["null"],
    release_reason: state === "released" ? ["text", "Reviewed"] : ["null"],
  };
}
async function snapshot(
  uploads: TaggedRow[] = [],
  owners: TaggedRow[] = [],
): Promise<LocalRecoverySnapshot> {
  const db = (await createTestDB()) as unknown as DB;
  const empty = await captureLocalRecoverySnapshot(db, keys, async () => ({
    baselineId: "baseline",
    effectSetIds: [],
  }));
  return {
    ...empty,
    tables: empty.tables.map((table) => ({
      ...table,
      rows:
        table.name === "local_image_upload"
          ? uploads
          : table.name === "local_asset_manifest"
            ? owners
            : [],
    })),
  };
}

it("requires unfinished uploads while retaining inactive upload identity records", async () => {
  const value = await snapshot([
    upload(4, "abandoned"),
    upload(2, "installed"),
    upload(3, "completed"),
    upload(1),
  ]);
  const before = JSON.stringify(value);
  const required = localRecoveryAssetManifest(value);
  expect(required).toEqual(manifest(1, 2));
  expect(JSON.stringify(value)).toBe(before);
  expect(Object.isFrozen(required.entries[0])).toBe(true);
});

it("collects pending and retained images for every owner kind without retaining released bytes", async () => {
  const owners: TaggedRow[] = [];
  const wanted = [];
  let n = 0;
  for (const kind of ["baseline", "effect-set", "pending-work", "transfer", "recovery"])
    for (const state of ["pending", "retained", "released"] as const) {
      owners.push(owner(++n, state, kind));
      if (state !== "released") wanted.push(n);
    }
  expect(localRecoveryAssetManifest(await snapshot([], owners))).toEqual(manifest(...wanted));
});

it("deduplicates identical requirements across uploads and independent manifest owners", async () => {
  expect(
    localRecoveryAssetManifest(await snapshot([upload(1)], [owner(1), owner(1, "retained")])),
  ).toEqual(manifest(1));
});

it.each(["active-owner", "released-owner", "inactive-upload", "released-pair"] as const)(
  "refuses immutable name collisions involving %s before allocating validation storage",
  async (source) => {
    const changed: TaggedRow = {
      ...owner(1, source === "active-owner" ? "pending" : "released"),
      manifest: ["text", JSON.stringify({ version: 1, entries: [entry(1, "b".repeat(64))] })],
    };
    const value =
      source === "released-pair"
        ? await snapshot([], [owner(1, "released"), { ...changed, owner_id: ["text", "other"] }])
        : await snapshot(
            [upload(1, source === "inactive-upload" ? "completed" : "pending")],
            [changed],
          );
    expect(() => localRecoveryAssetManifest(value)).toThrow("Conflicting asset bytes");
    const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
    await expect(validateLocalRecoverySnapshot(create, value, keys)).rejects.toThrow(
      "Conflicting asset bytes",
    );
    expect(create).not.toHaveBeenCalled();
  },
);

it("returns an empty requirement for empty or inactive-only snapshots", async () => {
  expect(localRecoveryAssetManifest(await snapshot())).toEqual(manifest());
  expect(
    localRecoveryAssetManifest(
      await snapshot([upload(1, "completed"), upload(2, "abandoned")], [owner(3, "released")]),
    ),
  ).toEqual(manifest());
});

it("includes selected shared history and checks it against inactive local identity records", async () => {
  const value = await snapshot([upload(1), upload(3, "completed")], [owner(2, "released")]);
  expect(localRecoveryAssetManifest(value, [manifest(3)])).toEqual(manifest(1, 3));
  expect(() =>
    localRecoveryAssetManifest(value, [{ version: 1, entries: [entry(3, "b".repeat(64))] }]),
  ).toThrow("Conflicting asset bytes");
});

it.each([
  ["upload", "filename", ["text", "../escape.svg"]],
  ["upload", "sha256", ["text", "a".repeat(64) + "\n"]],
  ["upload", "sha256", ["blob", "00"]],
  ["upload", "byte_length", ["integer", "0"]],
  ["upload", "byte_length", ["integer", "9223372036854775807"]],
  ["upload", "byte_length", ["real", "4008000000000000"]],
  ["upload", "state", ["text", "unknown"]],
  ["owner", "owner_kind", ["text", "unknown"]],
  ["owner", "owner_id", ["text", "bad\0owner"]],
  ["owner", "owner_id", ["text", " "]],
  ["owner", "manifest", ["text", "{"]],
  ["owner", "manifest", ["text", "{}"]],
  ["owner", "manifest", ["blob", "00"]],
  ["owner", "state", ["text", "unknown"]],
] as const)("refuses malformed inactive %s metadata in %s", async (kind, column, tagged) => {
  const row: TaggedRow = {
    ...(kind === "upload" ? upload(1, "abandoned") : owner(1, "released")),
    [column]: tagged as TaggedValue,
  };
  const value = await snapshot(kind === "upload" ? [row] : [], kind === "owner" ? [row] : []);
  const before = JSON.stringify(value);
  expect(() => localRecoveryAssetManifest(value)).toThrow();
  const create = vi.fn(async () => (await createTestDB()) as unknown as DB);
  await expect(validateLocalRecoverySnapshot(create, value, keys)).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(JSON.stringify(value)).toBe(before);
});

it("converts byte length only after checking its exact integer range", async () => {
  const row = { ...upload(1), byte_length: ["integer", String(IMAGE_MAX_BYTES)] as const };
  expect(localRecoveryAssetManifest(await snapshot([row])).entries[0].byteLength).toBe(
    IMAGE_MAX_BYTES,
  );
});
