import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDB } from "../../test-utils/db.js";
import {
  installCapturePrototype,
  captureApplicationRows,
  type CaptureAssetPublisher,
} from "../../test-utils/action-capture.js";
import type { DB as CoreDB } from "../../../../core/src/database.js";
import type { Tx } from "../database.js";
import { namespaceTable, localAssetManifestTable } from "../schema.js";
import {
  reserveAssetManifest,
  reserveAssetManifestInTx,
  confirmVerifiedAssetManifestInTx,
  releaseAssetManifestInTx,
  inspectAssetManifest,
  retainedImageNames,
} from "./asset-manifest.js";
import { defineActionRegistry } from "../../../../core/src/actions/registry.js";
import { runActionGroup } from "../../../../core/src/actions/execution.js";
import { createActionBindings } from "../../../../core/src/actions/bindings.js";
import { withTx } from "../database.js";

const name = (n: number) =>
  `.kozane/assets/images/00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const ref = (n: number) => `kozane-image:/api/images/${name(n).split("/").pop()}`;
const catalog = {
  version: 1 as const,
  entries: [1, 2].map((n) => ({ name: name(n), byteLength: 3, sha256: "a".repeat(64) })),
};
const staging = (id: string) => ({ kind: "pending-work" as const, id });

async function fixture(failure?: { phase: "baseline" | "effect-set"; commit: boolean }) {
  const db = await createTestDB();
  // The fixture and package interfaces use the same runtime adapter in both parity configurations.
  const core = db as unknown as CoreDB;
  await db.insert(namespaceTable).values({ id: "n", name: ref(1) });
  await reserveAssetManifest(db, staging("baseline"), {
    ...catalog,
    entries: catalog.entries.slice(0, 1),
  });
  await reserveAssetManifest(db, staging("effect-set"), catalog);
  if (failure?.commit) {
    await core.run(sql`CREATE TABLE deferred_parent(id TEXT PRIMARY KEY)`);
    await core.run(
      sql`CREATE TABLE deferred_child(parent_id TEXT REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
    );
    await core.run(
      sql`CREATE TRIGGER reject_publication AFTER UPDATE ON local_asset_manifest WHEN NEW.state='released' AND NEW.owner_id=${sql.raw(`'${failure.phase}'`)} BEGIN INSERT INTO deferred_child VALUES('missing'); END`,
    );
  }
  const publish: CaptureAssetPublisher = async (handle, publication) => {
    const tx = handle as unknown as Tx;
    const owner = {
      kind: publication.kind,
      id: publication.kind === "baseline" ? "baseline" : publication.id,
    };
    const reserved = await reserveAssetManifestInTx(tx, owner, publication.manifest);
    // Exercise trusted database finalization here. Node integration tests verify actual files.
    await confirmVerifiedAssetManifestInTx(tx, owner, reserved.record.manifest);
    await releaseAssetManifestInTx(tx, staging(publication.kind), "Published");
    if (failure?.phase === publication.kind && !failure.commit) throw new Error("Publisher failed");
  };
  const install = () => installCapturePrototype(core, catalog, publish);
  const registry = defineActionRegistry<{ replace: { content: string } }, { db: Tx }>({
    contractVersion: 1,
    schemaVersions: [26],
    definitions: {
      replace: {
        eligibility: "syncable",
        prepare: (input) => input as { content: string },
        replay: async (_input, { context }) => {
          await context.db.update(namespaceTable).set({ name: "Replaced" });
        },
      },
    },
  });
  const run = (capture: Awaited<ReturnType<typeof install>>) =>
    runActionGroup({
      db: core,
      registry,
      schemaVersion: 26,
      invocation: { id: "group", kind: "replace", contractVersion: 1, input: { content: ref(2) } },
      bindings: createActionBindings({
        mode: "record",
        allocateId: () => {
          throw new Error("Unexpected ID");
        },
        now: () => {
          throw new Error("Unexpected clock");
        },
      }),
      createContext: (_actions, handle) => ({ db: handle as unknown as Tx }),
      ...capture.hooks("run"),
    });
  const state = async () => ({
    rows: await captureApplicationRows(core),
    owners: await db.select().from(localAssetManifestTable),
    objects: await core.values(sql`SELECT name,sql FROM sqlite_schema ORDER BY name`),
  });
  return { db, install, run, state };
}

it("publishes capture and ledger ownership atomically on the active adapter", async () => {
  const f = await fixture();
  const capture = await f.install();
  await f.run(capture);
  expect((await f.db.select().from(namespaceTable))[0].name).toBe("Replaced");
  expect((await inspectAssetManifest(f.db, { kind: "baseline", id: "baseline" })).manifest).toEqual(
    capture.baselineManifest,
  );
  const effect = await inspectAssetManifest(f.db, { kind: "effect-set", id: "run" });
  expect(effect.record.state).toBe("retained");
  expect(effect.manifest).toEqual(catalog);
  expect(JSON.parse((await capture.runs())[0].assets!)).toEqual(effect.manifest);
  for (const id of ["baseline", "effect-set"])
    expect((await inspectAssetManifest(f.db, staging(id))).record.state).toBe("released");
  expect(await withTx(f.db, retainedImageNames)).toEqual(
    new Set(catalog.entries.map((entry) => entry.name.split("/").pop()!)),
  );
  await capture.verify();
});

it.each([
  { phase: "baseline", commit: false },
  { phase: "baseline", commit: true },
  { phase: "effect-set", commit: false },
  { phase: "effect-set", commit: true },
] as const)(
  "preserves staging after $phase publication fails (commit=$commit)",
  async (failure) => {
    const f = await fixture(failure);
    if (failure.phase === "baseline") {
      const before = await f.state();
      await expect(f.install()).rejects.toThrow();
      expect(await f.state()).toEqual(before);
    } else {
      const capture = await f.install();
      const before = await f.state();
      await expect(f.run(capture)).rejects.toThrow();
      expect(await f.state()).toEqual(before);
      expect(await capture.runs()).toEqual([]);
      expect(await capture.selection()).toEqual([]);
      expect(await capture.effects("run")).toEqual([]);
      await capture.verify();
    }
    expect((await inspectAssetManifest(f.db, staging(failure.phase))).record.state).toBe("pending");
    expect(await withTx(f.db, retainedImageNames)).toEqual(
      new Set(catalog.entries.map((entry) => entry.name.split("/").pop()!)),
    );
  },
);
