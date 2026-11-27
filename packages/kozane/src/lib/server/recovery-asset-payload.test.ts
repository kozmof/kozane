import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  withTx,
  withReadTx,
  createDatabaseAdapter,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import * as recovery from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { openDb } from "../../db/client.js";
import { saveRegisteredLocalRecoveryPayload } from "./local-recovery-payload.js";
import { saveRegisteredSharedRecoveryPayload } from "./shared-recovery-payload.js";
import * as sharedLoader from "./shared-recovery-payload.js";
import {
  saveRegisteredRecoveryAssetPayload,
  loadRegisteredRecoveryAssetPayload,
  inspectRegisteredRecoveryAssetPayload,
} from "./recovery-asset-payload.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@kozane/core/recovery", async (original) => ({
  ...(await original<typeof import("@kozane/core/recovery")>()),
}));
vi.mock("./shared-recovery-payload.js", async (original) => ({
  ...(await original<typeof import("./shared-recovery-payload.js")>()),
}));
let root: string;
let db: Awaited<ReturnType<typeof createTestDB>>;
let local: Awaited<ReturnType<typeof recovery.captureLocalRecoveryCheckpoint>>;
let shared: Awaited<ReturnType<typeof recovery.describeSharedRecoveryHistory>>;
let assets: Awaited<ReturnType<typeof recovery.describeRecoveryAssets>>;
const key = {
  workspaceId: "workspace",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
};
const identity = { ...key, schemaId: migrations.at(-1)!.id };
const factory = () => createTestDB();
const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
const manifest = (...ns: number[]) => ({
  version: 1 as const,
  entries: ns.map((n) => ({
    name: `.kozane/assets/images/${filename(n)}`,
    byteLength: 3,
    sha256: "a".repeat(64),
  })),
});
const row = (n: number) => ({
  id: ["text", "n"] as const,
  name: ["text", `kozane-image:/api/images/${filename(n)}`] as const,
  is_default: ["integer", "0"] as const,
});
const history = () => ({
  baseline: { id: "baseline", manifest: manifest(1) },
  effectSets: [
    { id: "edit", manifest: manifest(1, 2) },
    { id: "empty", manifest: manifest(3) },
  ],
});
const directory = () => join(root, ".kozane", "recovery", "asset-manifests");
const published = () => join(directory(), `${assets.checkpoint.sha256}.json`);
const temporary = () => join(directory(), `.pending-${assets.checkpoint.sha256}.json`);
const sourcePath = (area: "local" | "shared") =>
  join(
    root,
    ".kozane",
    "recovery",
    area === "local" ? "checkpoints" : "shared-history",
    `${area === "local" ? local.checkpoint.sha256 : shared.checkpoint.sha256}.json`,
  );
const sourceTemporary = (area: "local" | "shared") =>
  join(
    root,
    ".kozane",
    "recovery",
    area === "local" ? "checkpoints" : "shared-history",
    `.pending-${area === "local" ? local.checkpoint.sha256 : shared.checkpoint.sha256}.json`,
  );
const bytes = () => Buffer.from(JSON.stringify(assets.payload), "utf8");
const options = () => ({
  root,
  db,
  expected: identity,
  localMaxBytes: local.checkpoint.byteLength,
  sharedMaxBytes: shared.checkpoint.byteLength,
  maxBytes: assets.checkpoint.byteLength,
  createValidationDatabase: factory,
});
const save = () => saveRegisteredRecoveryAssetPayload({ ...options(), input: assets.payload });
const load = () => loadRegisteredRecoveryAssetPayload(options());
const inspect = () => inspectRegisteredRecoveryAssetPayload(root, db, key);
const catalog = async () => {
  const result = [];
  for (const table of [
    "local_recovery_checkpoint",
    "local_recovery_shared_history",
    "local_recovery_assets",
  ])
    result.push(
      await db.values(sql.raw(`SELECT descriptor,CAST(created_at AS TEXT) FROM ${table}`)),
    );
  return result;
};
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
  root = await fs.mkdtemp(join(tmpdir(), "kozane-asset-payload-"));
  db = await createTestDB(join(root, "db.sqlite"));
  await db.run(
    sql`INSERT INTO taskspace_local VALUES('absent','device-only', 'workspace_relative',9007199254740993)`,
  );
  await db.run(
    sql`INSERT INTO local_image_upload(filename,byte_length,sha256,state,created_at) VALUES(${filename(4)},3,${"a".repeat(64)},'pending',1)`,
  );
  local = await recovery.captureLocalRecoveryCheckpoint(db, identity, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, local.checkpoint);
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
          ].map((name) => ({ name, rows: name === "namespace" ? [row(1)] : [] })),
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
              op: "U",
              before: row(1),
              after: row(2),
            },
            {
              ord: 1,
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
        { id: "edit", effectCount: 2 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  const { binding } = await recovery.rememberSharedRecoveryCheckpoint(db, shared.checkpoint);
  assets = await recovery.describeRecoveryAssets({
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    binding,
    history: history(),
  });
  await recovery.rememberRecoveryAssetCheckpoint(db, assets.checkpoint);
  await saveRegisteredLocalRecoveryPayload({ ...options(), input: local.snapshot });
  await saveRegisteredSharedRecoveryPayload({ ...options(), input: shared.payload });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

it("publishes canonical manifests only after all three expectations commit and preserves source files", async () => {
  const before = await catalog();
  const sourceBytes = await Promise.all([
    fs.readFile(sourcePath("local")),
    fs.readFile(sourcePath("shared")),
  ]);
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    const reader = new DatabaseSync(join(root, "db.sqlite"), { readOnly: true });
    try {
      for (const [table, descriptor] of [
        ["local_recovery_assets", assets.checkpoint],
        ["local_recovery_shared_history", shared.checkpoint],
        ["local_recovery_checkpoint", local.checkpoint],
      ] as const)
        expect(reader.prepare(`SELECT descriptor FROM ${table}`).get()?.descriptor).toBe(
          JSON.stringify(descriptor),
        );
    } finally {
      reader.close();
    }
    expect(await fs.readFile(String(from))).toEqual(bytes());
    expect(existsSync(String(to))).toBe(false);
    return link(from, to);
  });
  expect(await save()).toEqual({ path: published(), checkpoint: assets.checkpoint, changed: true });
  expect(await fs.readFile(published())).toEqual(bytes());
  expect(existsSync(temporary())).toBe(false);
  if (process.platform !== "win32") expect((await fs.stat(published())).mode & 0o777).toBe(0o600);
  const stat = await fs.stat(published(), { bigint: true });
  expect((await save()).changed).toBe(false);
  expect(await fs.stat(published(), { bigint: true })).toMatchObject({
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
  });
  expect(
    await Promise.all([fs.readFile(sourcePath("local")), fs.readFile(sourcePath("shared"))]),
  ).toEqual(sourceBytes);
  expect(await catalog()).toEqual(before);
  expect(assets.payload.manifest).toEqual(manifest(1, 2, 3, 4));
  expect(existsSync(join(root, ".kozane", "assets"))).toBe(false);
});

it("inspects absent and orphaned evidence without creating directories or authorizing loading", async () => {
  const mkdir = vi.spyOn(fs, "mkdir");
  expect(await inspect()).toMatchObject({ published: "absent", temporary: "absent" });
  expect(mkdir).not.toHaveBeenCalled();
  await save();
  await db.run(sql`DELETE FROM local_recovery_checkpoint`);
  await db.run(sql`DELETE FROM local_recovery_shared_history`);
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  await expect(save()).rejects.toThrow();
  await expect(load()).rejects.toThrow();
  expect(await fs.readFile(published())).toEqual(bytes());
});

it("reopens exact manifests from another connection without filesystem writes or live row installation", async () => {
  await save();
  const before = await catalog();
  const targets: Awaited<ReturnType<typeof factory>>[] = [];
  const reopened = await openDb(`file:${join(root, "db.sqlite")}`);
  const mkdir = vi.spyOn(fs, "mkdir"),
    link = vi.spyOn(fs, "link"),
    unlink = vi.spyOn(fs, "unlink"),
    open = vi.spyOn(fs, "open");
  try {
    const result = await loadRegisteredRecoveryAssetPayload({
      ...options(),
      db: reopened.db,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    });
    expect(result).toEqual({ payload: assets.payload, checkpoint: assets.checkpoint });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.history.effectSets[0].manifest.entries[0])).toBe(true);
  } finally {
    reopened.close();
  }
  expect(targets).toHaveLength(2);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM local_image_upload`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM taskspace_local`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
  }
  expect(mkdir).not.toHaveBeenCalled();
  expect(link).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(
    open.mock.calls.every(
      (call) =>
        typeof call[1] === "number" && (call[1] & (constants.O_WRONLY | constants.O_RDWR)) === 0,
    ),
  ).toBe(true);
  expect(await catalog()).toEqual(before);
  expect(await fs.readFile(published())).toEqual(bytes());
});

it.each(["maxBytes", "localMaxBytes", "sharedMaxBytes"] as const)(
  "enforces the independent %s limit before file reads or SQL allocation",
  async (field) => {
    await save();
    const input = options();
    input[field]--;
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredRecoveryAssetPayload({ ...input, createValidationDatabase: create }),
    ).rejects.toThrow("exceeds read limit");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid byte limits %s before any file opens",
  async (limit) => {
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    for (const field of ["maxBytes", "localMaxBytes", "sharedMaxBytes"])
      await expect(
        loadRegisteredRecoveryAssetPayload({
          ...options(),
          [field]: limit,
          createValidationDatabase: create,
        }),
      ).rejects.toThrow("positive safe integer");
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["assets", "shared", "local"])(
  "refuses a missing %s catalog before reading asset bytes",
  async (which) => {
    await save();
    const table =
      which === "assets"
        ? "local_recovery_assets"
        : which === "shared"
          ? "local_recovery_shared_history"
          : "local_recovery_checkpoint";
    await db.run(sql.raw(`DELETE FROM ${table}`));
    const open = vi.spyOn(fs, "open"),
      create = vi.fn(factory);
    await expect(
      loadRegisteredRecoveryAssetPayload({ ...options(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it("refuses changed invocation-only requirements before allocating validation SQL or creating manifest files", async () => {
  const input = JSON.parse(JSON.stringify(assets.payload));
  input.history.effectSets[1].manifest = manifest();
  input.manifest = manifest(1, 2, 4);
  const create = vi.fn(factory);
  await expect(
    saveRegisteredRecoveryAssetPayload({ ...options(), input, createValidationDatabase: create }),
  ).rejects.toThrow("content mismatch");
  expect(create).not.toHaveBeenCalled();
  expect(existsSync(directory())).toBe(false);
});

it.each(["local", "shared"] as const)(
  "requires the saved %s source and preserves its interruption evidence",
  async (source) => {
    await fs.rename(sourcePath(source), sourceTemporary(source));
    const before = await fs.readFile(sourceTemporary(source));
    await expect(save()).rejects.toThrow("needs review");
    expect(existsSync(directory())).toBe(false);
    expect(await fs.readFile(sourceTemporary(source))).toEqual(before);
  },
);

it.each(["matching", "partial", "symlink"])(
  "preserves %s temporary manifest evidence",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), temporary());
    } else
      await fs.writeFile(temporary(), state === "matching" ? bytes() : Buffer.from("{partial"));
    const link = vi.spyOn(fs, "link"),
      unlink = vi.spyOn(fs, "unlink");
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(await inspect()).toMatchObject({
      published: "absent",
      temporary:
        state === "matching"
          ? "matching-content"
          : state === "symlink"
            ? "unsafe-path"
            : "different-content",
    });
  },
);

it.each(["different", "directory", "symlink"])(
  "refuses an existing %s manifest path without replacing it",
  async (state) => {
    await fs.mkdir(directory(), { recursive: true });
    if (state === "directory") await fs.mkdir(published());
    if (state === "different") await fs.writeFile(published(), "different");
    if (state === "symlink") {
      await fs.writeFile(join(root, "outside"), bytes());
      await fs.symlink(join(root, "outside"), published());
    }
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(existsSync(temporary())).toBe(false);
    expect(await inspect()).toMatchObject({
      published: state === "symlink" ? "unsafe-path" : "different-content",
      temporary: "absent",
    });
  },
);

it("refuses a symlinked manifest directory without writing its target", async () => {
  await fs.mkdir(join(root, "outside"));
  await fs.symlink(join(root, "outside"), directory());
  await expect(save()).rejects.toThrow("inspect retained evidence");
  expect(await fs.readdir(join(root, "outside"))).toEqual([]);
});

it.each(["link", "unlink"] as const)(
  "preserves manifest evidence after %s failure",
  async (failure) => {
    vi.spyOn(fs, failure).mockRejectedValueOnce(new Error("Publication failed"));
    const before = await catalog();
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({
      published: failure === "link" ? "absent" : "matching-content",
      temporary: "matching-content",
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await catalog()).toEqual(before);
  },
);

it.each(["partial-write", "file-sync", "directory-sync"])(
  "preserves evidence after %s failure",
  async (failure) => {
    if (failure === "directory-sync" && process.platform === "win32") return;
    const open = fs.open;
    let failed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (
        !failed &&
        String(args[0]) === (failure === "directory-sync" ? directory() : temporary())
      ) {
        failed = true;
        if (failure === "partial-write") {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
            await write(bytes().subarray(0, 10));
            throw new Error("Partial write");
          });
        } else vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("Sync failed"));
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
    if (failure === "directory-sync") expect((await save()).changed).toBe(false);
  },
);

it.each(["missing", "corrupt", "symlink", "temporary"])(
  "refuses %s manifest bytes before SQL validation",
  async (state) => {
    await save();
    if (state === "missing") await fs.unlink(published());
    if (state === "corrupt") await fs.writeFile(published(), Buffer.alloc(bytes().length, 120));
    if (state === "symlink") {
      await fs.rename(published(), join(root, "outside"));
      await fs.symlink(join(root, "outside"), published());
    }
    if (state === "temporary") await fs.writeFile(temporary(), bytes());
    const create = vi.fn(factory);
    await expect(
      loadRegisteredRecoveryAssetPayload({ ...options(), createValidationDatabase: create }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each(["utf8", "json", "noncanonical", "bom"])(
  "refuses hash-matching invalid %s manifest bytes before SQL allocation",
  async (state) => {
    const content =
      state === "utf8"
        ? Buffer.from([255, 254])
        : state === "json"
          ? Buffer.from("{invalid")
          : state === "bom"
            ? Buffer.from("\ufeff" + JSON.stringify(assets.payload))
            : Buffer.from(JSON.stringify(assets.payload, null, 2));
    const checkpoint = {
      ...assets.checkpoint,
      sha256: createHash("sha256").update(content).digest("hex"),
      byteLength: content.length,
    };
    await db.run(sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(checkpoint)}`);
    await fs.mkdir(directory(), { recursive: true });
    await fs.writeFile(join(directory(), `${checkpoint.sha256}.json`), content);
    const create = vi.fn(factory);
    await expect(
      loadRegisteredRecoveryAssetPayload({
        ...options(),
        maxBytes: content.length,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  },
);

it.each([
  "removed",
  "rewritten",
  "replaced",
  "new-temporary",
  "assets-binding",
  "local-file",
  "local-temporary",
])("refuses %s changes during source validation", async (change) => {
  await save();
  let calls = 0;
  await expect(
    loadRegisteredRecoveryAssetPayload({
      ...options(),
      createValidationDatabase: async () => {
        calls++;
        if (calls === 2) {
          if (change === "removed") await fs.unlink(published());
          if (change === "rewritten") {
            await fs.writeFile(published(), bytes());
            await fs.utimes(published(), new Date(2000), new Date(2000));
          }
          if (change === "replaced") {
            const next = join(directory(), "next.json");
            await fs.writeFile(next, bytes());
            await fs.rename(next, published());
          }
          if (change === "new-temporary") await fs.writeFile(temporary(), bytes());
          if (change === "assets-binding")
            await db.run(
              sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...assets.checkpoint, sha256: "b".repeat(64) })}`,
            );
          if (change === "local-file") await fs.writeFile(sourcePath("local"), "changed");
          if (change === "local-temporary") await fs.writeFile(sourceTemporary("local"), "partial");
        }
        return factory();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(2);
});

it.each(["local", "shared"] as const)(
  "keeps published manifest evidence if the %s source changes during publication",
  async (source) => {
    const link = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
      await fs.writeFile(sourcePath(source), "changed");
      return link(...args);
    });
    await expect(save()).rejects.toThrow("inspect retained evidence");
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
  },
);

it("refuses coherent replacement of all bindings after content verification", async () => {
  const require = recovery.requireRecoveryAssetCheckpoint;
  vi.spyOn(recovery, "requireRecoveryAssetCheckpoint").mockImplementationOnce(async (...args) => {
    const result = await require(...args);
    const localCheckpoint = { ...local.checkpoint, sha256: "b".repeat(64) };
    const checkpoint = { ...shared.checkpoint, sha256: "c".repeat(64) };
    const binding = { checkpoint, localCheckpoint };
    await withTx(db, async (tx) => {
      await tx.run(
        sql`UPDATE local_recovery_checkpoint SET descriptor=${JSON.stringify(localCheckpoint)}`,
      );
      await tx.run(
        sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(checkpoint)},local_descriptor=${JSON.stringify(localCheckpoint)}`,
      );
      await tx.run(
        sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify({ ...assets.checkpoint, binding })}`,
      );
    });
    return result;
  });
  await expect(save()).rejects.toThrow("binding changed");
  expect(existsSync(directory())).toBe(false);
});

it.each(["save", "load"])("owns identity, payload and limits during %s callbacks", async (mode) => {
  if (mode === "load") await save();
  const input = {
    ...options(),
    input: JSON.parse(JSON.stringify(assets.payload)),
    expected: { ...identity },
  };
  input.createValidationDatabase = async () => {
    input.expected.deviceId = "changed";
    input.input.manifest.entries.length = 0;
    input.root = join(root, "elsewhere");
    input.localMaxBytes = 0;
    input.sharedMaxBytes = 0;
    return factory();
  };
  if (mode === "save") await saveRegisteredRecoveryAssetPayload(input);
  else expect((await loadRegisteredRecoveryAssetPayload(input)).payload).toEqual(assets.payload);
  expect(await fs.readFile(published())).toEqual(bytes());
});

it.each(["save", "load"])(
  "refuses %s success after the final outer commit fails while preserving earlier evidence",
  async (mode) => {
    if (mode === "load") await save();
    let ready = false;
    const original = sharedLoader.loadRegisteredSharedRecoveryPayload;
    vi.spyOn(sharedLoader, "loadRegisteredSharedRecoveryPayload").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        ready = true;
        return result;
      },
    );
    const wrapped = createDatabaseAdapter(new Proxy(db, {}), {
      read: (operation) => withReadTx(db, (tx) => operation(tx as unknown as DatabaseHandle)),
      write: (operation) =>
        withTx(db, async (tx) => {
          const result = await operation(tx);
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
    const before = await catalog();
    if (mode === "save")
      await expect(
        saveRegisteredRecoveryAssetPayload({ ...options(), input: assets.payload, db: wrapped }),
      ).rejects.toThrow();
    else
      await expect(
        loadRegisteredRecoveryAssetPayload({ ...options(), db: wrapped }),
      ).rejects.toThrow();
    expect(ready).toBe(true);
    expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
    expect(await catalog()).toEqual(before);
    expect((await save()).changed).toBe(false);
  },
);

it("serializes all three catalog removals across exclusive manifest publication", async () => {
  const other = await openDb(`file:${join(root, "db.sqlite")}`);
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const link = fs.link;
  vi.spyOn(fs, "link").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return link(...args);
  });
  const saving = save();
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
    proceed.resolve();
    await saving;
  } finally {
    proceed.resolve();
    await saving.catch(() => undefined);
    other.close();
  }
  expect(await inspect()).toMatchObject({ published: "matching-content", temporary: "absent" });
});

it("requires the host's full checkpoint identity before file reads", async () => {
  await save();
  const open = vi.spyOn(fs, "open"),
    create = vi.fn(factory);
  for (const field of ["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const) {
    const expected = {
      ...identity,
      [field]: field === "schemaId" ? migrations.at(-2)!.id : "another",
    };
    await expect(
      loadRegisteredRecoveryAssetPayload({
        ...options(),
        expected,
        createValidationDatabase: create,
      }),
    ).rejects.toThrow();
  }
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("still requires isolated source SQL validation after all canonical content hashes match", async () => {
  const projection = recovery.parseSharedRecoveryProjection({
    version: 1,
    rowEncodingVersion: 1,
    schemaId: identity.schemaId,
    tables: shared.projection.tables.map(({ name }) => ({
      name,
      rows:
        name === "namespace"
          ? [row(1)]
          : name === "warp"
            ? [
                {
                  id: ["text", "w"],
                  namespace_id: ["text", "n"],
                  pos_x: ["integer", "0"],
                  pos_y: ["real", "3ff0000000000000"],
                },
              ]
            : [],
    })),
  });
  shared = await recovery.describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection },
      effectSets: [
        { id: "edit", effects: [] },
        { id: "empty", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "edit", effectCount: 0 },
        { id: "empty", effectCount: 0 },
      ],
    },
  );
  const binding = { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint };
  assets = await recovery.describeRecoveryAssets({
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    binding,
    history: history(),
  });
  await db.run(
    sql`UPDATE local_recovery_shared_history SET descriptor=${JSON.stringify(shared.checkpoint)}`,
  );
  await db.run(
    sql`UPDATE local_recovery_assets SET descriptor=${JSON.stringify(assets.checkpoint)}`,
  );
  // Inject otherwise hash-valid source bytes to exercise affinity validation at the read boundary.
  await fs.writeFile(sourcePath("shared"), Buffer.from(JSON.stringify(shared.payload)));
  const targets: Awaited<ReturnType<typeof factory>>[] = [];
  await expect(
    saveRegisteredRecoveryAssetPayload({
      ...options(),
      input: assets.payload,
      createValidationDatabase: async () => {
        const target = await factory();
        targets.push(target);
        return target;
      },
    }),
  ).rejects.toThrow("differs from projection");
  expect(targets).toHaveLength(2);
  for (const target of targets) {
    expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM warp`)).toEqual([]);
    expect(await target.values(sql`SELECT 1 FROM local_image_upload`)).toEqual([]);
  }
  expect(existsSync(directory())).toBe(false);
});

it("saves and reopens invocation manifests larger than the fixed verification buffer", async () => {
  const expected = { ...identity, checkpointId: "large" };
  const largeLocal = await recovery.captureLocalRecoveryCheckpoint(db, expected, async () => ({
    baselineId: "baseline",
    effectSetIds: ["edit", "empty"],
  }));
  await recovery.rememberLocalRecoveryCheckpoint(db, largeLocal.checkpoint);
  const largeShared = await recovery.describeSharedRecoveryHistory(
    shared.payload.history,
    expected,
    shared.payload.selection,
  );
  const { binding } = await recovery.rememberSharedRecoveryCheckpoint(db, largeShared.checkpoint);
  const largeHistory = history();
  largeHistory.effectSets[1].manifest = manifest(...Array.from({ length: 600 }, (_, n) => n + 3));
  const large = await recovery.describeRecoveryAssets({
    localSnapshot: largeLocal.snapshot,
    sharedHistory: largeShared.payload,
    binding,
    history: largeHistory,
  });
  await recovery.rememberRecoveryAssetCheckpoint(db, large.checkpoint);
  const input = {
    ...options(),
    expected,
    localMaxBytes: largeLocal.checkpoint.byteLength,
    sharedMaxBytes: largeShared.checkpoint.byteLength,
    maxBytes: large.checkpoint.byteLength,
  };
  await saveRegisteredLocalRecoveryPayload({ ...input, input: largeLocal.snapshot });
  await saveRegisteredSharedRecoveryPayload({ ...input, input: largeShared.payload });
  expect(large.checkpoint.byteLength).toBeGreaterThan(65536);
  const saved = await saveRegisteredRecoveryAssetPayload({ ...input, input: large.payload });
  expect(await fs.readFile(saved.path)).toEqual(Buffer.from(JSON.stringify(large.payload)));
  expect((await loadRegisteredRecoveryAssetPayload(input)).payload).toEqual(large.payload);
});
