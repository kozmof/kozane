import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  createDatabaseAdapter,
  withReadTx,
  withTx,
  type DatabaseHandle,
} from "@kozane/core/database";
import { migrations } from "@kozane/core/migrations";
import {
  describeSharedRecoveryRunArchive as describe,
  requireSharedRecoveryRunArchiveCheckpoint as verify,
  validateSharedRecoveryRunArchive as validate,
  parseSharedRecoveryRunArchive as parse,
  parseSharedRecoveryRunArchiveCheckpoint as parseCheckpoint,
  sharedRecoveryRunArchiveAssetManifest as collectImages,
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryActions,
  describeSharedRecoveryActionArchive,
  reconstructSharedRecoveryProjection,
  type SharedRecoveryRunArchiveSources,
} from "@kozane/core/recovery";
import { createTestDB } from "../../test-utils/db.js";
import { sharedRecoveryRunArchiveFixture as fixture } from "../../test-utils/shared-recovery-run-archive.js";
import {
  identity,
  reference,
  filename,
  manifest,
  projection,
  clone,
} from "../../test-utils/retained-recovery-assets.js";
beforeEach(async () => {
  if (!globalThis.crypto?.subtle) vi.stubGlobal("crypto", (await import("node:crypto")).webcrypto);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const sources = (f: SharedRecoveryRunArchiveSources) => ({
  actionArchive: f.actionArchive,
  originals: f.originals,
  executions: f.executions,
  sharedHistory: f.sharedHistory,
});
const detached = (f: Awaited<ReturnType<typeof fixture>>, id = "detached-origin") =>
  f.effectSets.find((s: { id: string }) => s.id === id);
async function redescribeSet(set: any) {
  const history = await describeSharedRecoveryHistory(
    set.history.history,
    identity,
    set.history.selection,
  );
  set.history = history.payload;
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: history.checkpoint,
    sharedHistory: history.payload,
    selection: set.executions.selection,
    effectSets: set.executions.effectSets,
  });
  set.executions = executions.payload;
}
function checkpointFor(payload: unknown, original: any) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    ...original,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
it("binds additional origin, rebase and authoritative runs without advancing current materialization", async () => {
  const f = await fixture(),
    result = await describe(f);
  expect(result.payload.effectSets.map((s) => s.id)).toEqual([
    "origin",
    "detached-authoritative",
    "detached-rebase",
    "detached-origin",
    "noop",
    "superseded",
    "rebase",
  ]);
  expect(result.payload.checkpoint).toEqual(f.checkpoint);
  expect(result.payload.selection).toEqual(f.selection);
  const origin = detached(f),
    rebased = detached(f, "detached-rebase");
  expect(origin.executions.effectSets[0].executions.map((a: { id: string }) => a.id)).toEqual([
    "detached",
    "detached-child",
    "detached-grand",
    "detached-skipped",
  ]);
  expect(origin.executions.effectSets[0].executions[1].input).toEqual({ ref: reference(18) });
  expect(rebased.executions.effectSets[0].executions[1].input).toEqual({ ref: reference(23) });
  expect(rebased.executions.effectSets[0].invocation.contractVersion).toBe(77);
  expect(origin.executions.effectSets[0].invocation.input.text).toBe('\ufeff{"exact":true}\0🪁');
  expect(
    reconstructSharedRecoveryProjection(
      f.sharedHistory.history,
      f.sharedHistory.selection,
    ).tables.every((t) => !t.rows.length),
  ).toBe(true);
  expect(Object.isFrozen(result.payload.effectSets[3].history.history.baseline.projection)).toBe(
    true,
  );
  expect(result.checkpoint).toEqual(checkpointFor(result.payload, result.checkpoint));
  expect(await verify(result.payload, result.checkpoint, identity, sources(f))).toEqual(
    result.payload,
  );
  expect(parseCheckpoint(result.checkpoint)).toEqual(result.checkpoint);
  const reversed = { ...f, effectSets: [...f.effectSets].reverse() };
  expect((await describe(reversed)).checkpoint).toEqual(result.checkpoint);
});
it.each([
  "duplicate",
  "unselected",
  "missing",
  "missing-selected",
  "foreign-root",
  "source",
  "provenance",
  "baseline",
  "row-count",
  "execution-count",
  "ordinal",
  "local-table",
  "before-image",
])("refuses malformed run archive %s", async (change) => {
  const f = await fixture(),
    result = await describe(f),
    payload = clone(result.payload);
  const run = detached(payload);
  if (change === "duplicate") payload.effectSets.push(payload.effectSets[0]);
  if (change === "unselected") payload.effectSets.push({ ...run, id: "other" });
  if (change === "missing") payload.effectSets.pop();
  if (change === "missing-selected") {
    payload.effectSets.pop();
    payload.selection.effectSets.pop();
  }
  if (change === "foreign-root") payload.selection.effectSets[1].rootId = "not-archived";
  if (change === "source") payload.selection.effectSets[1].source = "unknown";
  if (change === "provenance") run.source = "rebase";
  if (change === "baseline") payload.selection.effectSets[1].baselineId = "other";
  if (change === "row-count") payload.selection.effectSets[1].effectCount++;
  if (change === "execution-count") payload.selection.effectSets[1].executionCount--;
  if (change === "ordinal") run.history.history.effectSets[0].effects[0].ord = 1;
  if (change === "local-table")
    run.history.history.effectSets[0].effects[0].table = "taskspace_local";
  if (change === "before-image")
    run.history.history.effectSets[0].effects[0].before.name = ["text", "other"];
  expect(() => parse(payload)).toThrow();
});
it.each(["truncated-root", "source", "child-input", "inventory-order", "bindings", "provenance"])(
  "requires the original trusted descriptor after %s changes",
  async (change) => {
    const f = await fixture(),
      result = await describe(f),
      payload = clone(result.payload);
    if (change === "truncated-root") {
      payload.effectSets = payload.effectSets.filter(
        (s: { rootId: string }) => s.rootId !== "detached",
      );
      payload.selection.effectSets = payload.selection.effectSets.filter(
        (s: { rootId: string }) => s.rootId !== "detached",
      );
    }
    if (change === "source") {
      detached(payload).source = "authoritative";
      payload.selection.effectSets.find((s: { id: string }) => s.id === "detached-origin").source =
        "authoritative";
    }
    if (change === "child-input")
      detached(payload, "detached-rebase").executions.effectSets[0].executions[1].input.ref =
        reference(40);
    if (change === "inventory-order") {
      payload.selection.effectSets.reverse();
      payload.effectSets.reverse();
    }
    if (change === "bindings")
      detached(payload).executions.effectSets[0].generated.unused.value = "changed";
    if (change === "provenance") payload.checkpoint.sha256 = "b".repeat(64);
    await expect(verify(payload, result.checkpoint, identity, sources(f))).rejects.toThrow();
  },
);
it.each([
  "selected-context",
  "selected-rows",
  "selected-input",
  "original-root",
  "original-parent",
  "original-kind",
  "original-version",
  "unused-binding",
  "used-binding",
  "missing-original",
  "foreign-identity",
])("refuses %s drift in otherwise complete inventories", async (change) => {
  const f = await fixture(),
    options = clone(f),
    run = detached(options, "detached-rebase"),
    selected = options.effectSets.find((s: { id: string }) => s.id === "rebase");
  if (change === "selected-context") {
    selected.history.history.baseline.projection.tables.find(
      (t: { name: string }) => t.name === "namespace",
    ).rows[0].name = ["text", reference(40)];
    selected.history.history.effectSets[0].effects[0].before.name = ["text", reference(40)];
    await redescribeSet(selected);
  }
  if (change === "selected-rows") {
    selected.history.history.effectSets[0].effects[0].after.name = ["text", reference(40)];
    selected.history.history.effectSets[0].effects[1].before.name = ["text", reference(40)];
    await redescribeSet(selected);
  }
  if (change === "selected-input")
    selected.executions.effectSets[0].executions[1].input.ref = reference(40);
  if (change === "original-root") {
    run.executions.effectSets[0].invocation.input.ref = reference(40);
    run.executions.effectSets[0].executions[0].input.ref = reference(40);
  }
  if (change === "original-parent")
    run.executions.effectSets[0].executions[2].parentId = "detached";
  if (change === "original-kind") run.executions.effectSets[0].executions[1].kind = "future.other";
  if (change === "original-version")
    for (const a of run.executions.effectSets[0].executions) a.contractVersion = 78;
  if (change === "unused-binding") run.executions.effectSets[0].generated.unused.value = "changed";
  if (change === "used-binding")
    run.executions.effectSets[0].executions[0].generated.child.value = "changed";
  if (change === "missing-original") run.executions.effectSets[0].executions[2].id = "not-archived";
  if (change === "foreign-identity") run.history.identity.deviceId = "other";
  await expect(describe(options)).rejects.toThrow();
});
it.each(["actionArchive", "originals", "executions", "sharedHistory"] as const)(
  "checks the %s source even with a matching outer hash",
  async (field) => {
    const f = await fixture(),
      result = await describe(f),
      contents = clone(sources(f));
    if (field === "actionArchive") contents.actionArchive.actions[2].hlc = "changed";
    if (field === "originals") contents.originals.actions[1].hlc = "changed";
    if (field === "executions")
      contents.executions.effectSets[0].executions[1].input.ref = reference(40);
    if (field === "sharedHistory") contents.sharedHistory.history.baseline.id = "changed";
    await expect(verify(result.payload, result.checkpoint, identity, contents)).rejects.toThrow();
  },
);
it("checks each nested run hash after deliberate outer rehashing", async () => {
  const f = await fixture(),
    result = await describe(f),
    payload = clone(result.payload);
  detached(payload).executions.checkpoint.sha256 = "b".repeat(64);
  await expect(
    verify(payload, checkpointFor(payload, result.checkpoint), identity, sources(f)),
  ).rejects.toThrow("content mismatch");
});
it.each(["workspaceId", "deviceId", "epochId", "checkpointId", "schemaId"] as const)(
  "requires host %s before hashing",
  async (field) => {
    const f = await fixture(),
      result = await describe(f),
      digest = vi.spyOn(crypto.subtle, "digest");
    await expect(
      verify(
        result.payload,
        result.checkpoint,
        { ...identity, [field]: field === "schemaId" ? migrations.at(-2)!.id : "other" },
        sources(f),
      ),
    ).rejects.toThrow();
    expect(digest).not.toHaveBeenCalled();
  },
);
it.each(["description", "verification", "validation"])(
  "owns all run and source inputs before hashing during %s",
  async (mode) => {
    const f = await fixture(),
      expected = await describe(f),
      input = clone(f),
      payload = clone(expected.payload),
      checkpoint = clone(expected.checkpoint),
      host = { ...identity };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      input.effectSets.length = 0;
      input.selection.effectSets.length = 0;
      input.actionArchive.actions.length = 0;
      input.originals.actions.length = 0;
      input.executions.effectSets.length = 0;
      input.sharedHistory.history.effectSets.length = 0;
      payload.effectSets.length = 0;
      checkpoint.sha256 = "b".repeat(64);
      host.deviceId = "changed";
      return digest(...args);
    });
    const actual =
      mode === "description"
        ? (await describe(input)).payload
        : mode === "verification"
          ? await verify(payload, checkpoint, host, sources(input))
          : await validate(createTestDB, payload, checkpoint, host, sources(input));
    expect(actual).toEqual(expected.payload);
  },
);
it.each(["getter", "array-getter", "toJSON", "extra-field", "version", "duplicate-selection"])(
  "refuses %s transport without invoking hooks",
  async (change) => {
    const f = await fixture(),
      result = await describe(f),
      payload = clone(result.payload),
      invoked = vi.fn();
    if (change === "getter")
      Object.defineProperty(payload.effectSets[0], "history", { enumerable: true, get: invoked });
    if (change === "array-getter")
      Object.defineProperty(payload.effectSets, "0", { enumerable: true, get: invoked });
    if (change === "toJSON") payload.effectSets[0].toJSON = invoked;
    if (change === "extra-field") payload.effectSets[0].extra = true;
    if (change === "version") payload.version++;
    if (change === "duplicate-selection")
      payload.selection.effectSets.push(payload.selection.effectSets[0]);
    expect(() => parse(payload)).toThrow();
    expect(invoked).not.toHaveBeenCalled();
  },
);
it.each(["version", "hash", "hash-newline", "length", "missing-selected", "root", "archive-roots"])(
  "refuses malformed checkpoint %s",
  async (change) => {
    const f = await fixture(),
      result = await describe(f),
      checkpoint = clone(result.checkpoint);
    if (change === "version") checkpoint.version++;
    if (change === "hash") checkpoint.sha256 = "A".repeat(64);
    if (change === "hash-newline") checkpoint.sha256 += "\n";
    if (change === "length") checkpoint.byteLength = 0;
    if (change === "missing-selected") checkpoint.selection.effectSets.pop();
    if (change === "root") checkpoint.selection.effectSets[0].rootId = "not-archived";
    if (change === "archive-roots") checkpoint.checkpoint.selection.rootIds = ["detached"];
    expect(() => parseCheckpoint(checkpoint)).toThrow();
  },
);
it("keeps historical descriptors as metadata while refusing historical run rows", async () => {
  const f = await fixture(),
    result = await describe(f),
    old = clone(result.checkpoint);
  old.checkpoint.checkpoint.checkpoint.checkpoint.identity.schemaId = migrations.at(-2)!.id;
  expect(parseCheckpoint(old)).toEqual(old);
  expect(() => parse({ ...result.payload, checkpoint: old.checkpoint })).toThrow("Unsupported");
});
it("validates both endpoints of every run in isolation and rolls back all rows", async () => {
  const f = await fixture(),
    result = await describe(f),
    targets: Awaited<ReturnType<typeof createTestDB>>[] = [];
  expect(
    await validate(
      async () => {
        const db = await createTestDB();
        targets.push(db);
        return db;
      },
      result.payload,
      result.checkpoint,
      identity,
      sources(f),
    ),
  ).toEqual(result.payload);
  expect(targets).toHaveLength(14);
  for (const db of targets) {
    expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
    expect(await db.values(sql`SELECT 1 FROM warp`)).toEqual([]);
  }
});
it("rejects changed trusted content before allocating SQL databases", async () => {
  const f = await fixture(),
    result = await describe(f),
    create = vi.fn(createTestDB);
  await expect(
    validate(
      create,
      result.payload,
      { ...result.checkpoint, sha256: "b".repeat(64) },
      identity,
      sources(f),
    ),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});
it.each(["before-affinity", "after-foreign-key"])(
  "checks detached %s states despite matching hashes",
  async (defect) => {
    const f = clone(await fixture()),
      run = detached(f, "detached-rebase"),
      warp = {
        id: ["text", "w"],
        namespace_id: ["text", defect === "before-affinity" ? "n" : "missing"],
        pos_x: ["integer", "0"],
        pos_y: defect === "before-affinity" ? ["real", "3ff0000000000000"] : ["integer", "0"],
      };
    if (defect === "before-affinity")
      run.history.history.baseline.projection.tables
        .find((t: { name: string }) => t.name === "warp")
        .rows.push(warp);
    else {
      run.history.history.effectSets[0].effects.push({
        ord: 2,
        table: "warp",
        key: { id: ["text", "w"] },
        op: "I",
        before: null,
        after: warp,
      });
      run.history.selection.effectSets[0].effectCount++;
      run.executions.effectSets[0].effects.push({ ord: 2, actionId: "detached", executionOrd: 0 });
      f.selection.effectSets.find((s: { id: string }) => s.id === run.id).effectCount++;
    }
    await redescribeSet(run);
    const result = await describe(f),
      targets: Awaited<ReturnType<typeof createTestDB>>[] = [];
    await expect(
      validate(
        async () => {
          const db = await createTestDB();
          targets.push(db);
          return db;
        },
        result.payload,
        result.checkpoint,
        identity,
        sources(f),
      ),
    ).rejects.toThrow();
    expect(targets).toHaveLength(defect === "before-affinity" ? 5 : 6);
    for (const db of targets) {
      expect(await db.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
      expect(await db.values(sql`SELECT 1 FROM warp`)).toEqual([]);
    }
  },
);
it("refuses success if an endpoint commit fails", async () => {
  const f = await fixture(),
    result = await describe(f),
    target = await createTestDB();
  const wrapped = createDatabaseAdapter(new Proxy(target, {}), {
    read: (work) => withReadTx(target, (tx) => work(tx as unknown as DatabaseHandle)),
    write: (work) =>
      withTx(target, async (tx) => {
        await work(tx);
        throw new Error("Endpoint commit failed");
      }),
  });
  await expect(
    validate(async () => wrapped, result.payload, result.checkpoint, identity, sources(f)),
  ).rejects.toThrow("Endpoint commit failed");
  expect(await target.values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});
it("collects every run's row and actual input images and preserves extras", async () => {
  const f = await fixture(),
    result = await describe(f),
    images = collectImages(result.payload, f.images);
  for (const n of [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])
    expect(images.entries.some((e) => e.name.endsWith(filename(n)))).toBe(true);
  expect(images.entries.some((e) => e.name.endsWith(filename(12)))).toBe(false);
});
it.each([
  "baseline",
  "intermediate",
  "root",
  "child",
  "grandchild",
  "skipped",
  "selection",
  "conflict",
])("requires per-run image %s coverage", async (change) => {
  const f = await fixture(),
    result = await describe(f),
    images = clone(f.images),
    entry = images.effectSets.find((s: { id: string }) => s.id === "detached-origin");
  if (change === "baseline") entry.history.baseline.manifest = manifest();
  if (["intermediate", "root", "child", "grandchild", "skipped"].includes(change)) {
    const n =
      change === "intermediate"
        ? 22
        : change === "root"
          ? 17
          : change === "child"
            ? 18
            : change === "grandchild"
              ? 19
              : 20;
    entry.history.effectSets[0].manifest.entries =
      entry.history.effectSets[0].manifest.entries.filter(
        (e: { name: string }) => !e.name.endsWith(filename(n)),
      );
  }
  if (change === "selection") images.effectSets.reverse();
  if (change === "conflict") entry.history.baseline.manifest.entries[0].sha256 = "b".repeat(64);
  expect(() => collectImages(result.payload, images)).toThrow();
});
async function withoutSelectedRuns(
  f: Awaited<ReturnType<typeof fixture>>,
  invalidBaseline = false,
) {
  const before = clone(projection(1));
  if (invalidBaseline)
    before.tables
      .find((t: { name: string }) => t.name === "warp")
      .rows.push({
        id: ["text", "w"],
        namespace_id: ["text", "missing"],
        pos_x: ["integer", "0"],
        pos_y: ["integer", "0"],
      });
  const history = await describeSharedRecoveryHistory(
    { baseline: { id: "baseline", projection: before }, effectSets: [] },
    identity,
    { baselineId: "baseline", effectSets: [] },
  );
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: history.checkpoint,
    sharedHistory: history.payload,
    selection: { baselineId: "baseline", effectSets: [] },
    effectSets: [],
  });
  const originals = await describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: history.payload,
    selection: { actionIds: [] },
    actions: [],
  });
  const actions = f.actionArchive.actions.filter((a) => a.rootId === "detached");
  const archive = await describeSharedRecoveryActionArchive({
    checkpoint: originals.checkpoint,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: history.payload,
    selection: { rootIds: ["detached"], actionIds: actions.map((a) => a.id) },
    actions,
  });
  return {
    ...f,
    checkpoint: archive.checkpoint,
    actionArchive: archive.payload,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: history.payload,
    effectSets: f.effectSets.filter((s: { rootId: string }) => s.rootId === "detached"),
    selection: {
      effectSets: f.selection.effectSets.filter((s: { rootId: string }) => s.rootId === "detached"),
    },
  };
}
it("retains extra runs without selected actions and validates the current baseline too", async () => {
  const f = await withoutSelectedRuns(await fixture()),
    result = await describe(f),
    create = vi.fn(createTestDB);
  expect(result.payload.effectSets).toHaveLength(3);
  expect(await validate(create, result.payload, result.checkpoint, identity, sources(f))).toEqual(
    result.payload,
  );
  expect(create).toHaveBeenCalledTimes(7);
});
it("rejects a SQL-invalid current baseline even with valid detached endpoints", async () => {
  const f = await withoutSelectedRuns(await fixture(), true),
    result = await describe(f),
    targets: Awaited<ReturnType<typeof createTestDB>>[] = [];
  await expect(
    validate(
      async () => {
        const db = await createTestDB();
        targets.push(db);
        return db;
      },
      result.payload,
      result.checkpoint,
      identity,
      sources(f),
    ),
  ).rejects.toThrow();
  expect(targets).toHaveLength(1);
  expect(await targets[0].values(sql`SELECT 1 FROM namespace`)).toEqual([]);
});
it("validates the current baseline once when the independently trusted run inventory is empty", async () => {
  const f = await withoutSelectedRuns(await fixture());
  f.effectSets = [];
  f.selection.effectSets = [];
  const result = await describe(f),
    create = vi.fn(createTestDB);
  await validate(create, result.payload, result.checkpoint, identity, sources(f));
  expect(create).toHaveBeenCalledTimes(1);
});
