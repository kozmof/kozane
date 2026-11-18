/** Complete pure recovery sources and per-run manifests shared by retained asset tests. */
import { migrations } from "@kozane/core/migrations";
import {
  describeLocalRecoverySnapshot,
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  describeSharedRecoveryActions,
  describeSharedRecoveryRetainedHistory,
  describeRecoveryAssets,
  type SharedRecoveryEffectSetSource,
} from "@kozane/core/recovery";
import { localTableNames } from "../../../core/src/actions/local-tables.js";
import { capturedTables } from "./action-tables.js";
export const identity = {
  workspaceId: "workspace🪁",
  deviceId: "device",
  epochId: "epoch",
  checkpointId: "checkpoint",
  schemaId: migrations.at(-1)!.id,
};
export const filename = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}.svg`;
export const reference = (n: number) => `kozane-image:/api/images/${filename(n)}`;
export const manifest = (...ns: number[]) => ({
  version: 1 as const,
  entries: ns.map((n) => ({
    name: `.kozane/assets/images/${filename(n)}`,
    byteLength: 3,
    sha256: "a".repeat(64),
  })),
});
export const row = (n: number) => ({
  id: ["text", "n"],
  name: ["text", reference(n)],
  is_default: ["integer", "0"],
});
export const projection = (n?: number) => ({
  version: 1,
  rowEncodingVersion: 1,
  schemaId: identity.schemaId,
  tables: capturedTables.map(({ name }) => ({
    name,
    rows: name === "namespace" && n !== undefined ? [row(n)] : [],
  })),
});
export const effects = (from: number, to: number) => [
  {
    ord: 0,
    table: "namespace",
    key: { id: ["text", "n"] },
    op: "U",
    before: row(from),
    after: row(to),
  },
  { ord: 1, table: "namespace", key: { id: ["text", "n"] }, op: "D", before: row(to), after: null },
];
export const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
export async function retainedRecoveryAssetFixture() {
  const root = {
      id: "root",
      kind: "future.root",
      contractVersion: 99,
      input: { ref: reference(0), text: '\ufeff{"text":"exact"}\0🪁' },
    },
    generated = {
      child: { type: "child-id", value: "child" },
      skipped: { type: "child-id", value: "skipped" },
      unused: { type: "entity-id", value: "unused" },
    };
  const group = (id: string, child?: number) => ({
    id,
    invocation: root,
    generated,
    executions: [
      {
        ...root,
        parentId: null,
        executionOrd: 0,
        generated: child === undefined ? {} : { child: generated.child },
      },
      ...(child === undefined
        ? []
        : [
            {
              id: "child",
              kind: "future.child",
              contractVersion: 99,
              parentId: "root",
              executionOrd: 1,
              input: { ref: reference(child) },
              generated: {},
            },
          ]),
    ],
    effects:
      child === undefined
        ? []
        : [
            { ord: 0, actionId: "child", executionOrd: 1 },
            { ord: 1, actionId: "root", executionOrd: 0 },
          ],
  });
  const shared = await describeSharedRecoveryHistory(
    {
      baseline: { id: "baseline", projection: projection(1) },
      effectSets: [
        { id: "rebase", effects: effects(1, 2) },
        { id: "noop", effects: [] },
      ],
    },
    identity,
    {
      baselineId: "baseline",
      effectSets: [
        { id: "rebase", effectCount: 2 },
        { id: "noop", effectCount: 0 },
      ],
    },
  );
  const local = await describeLocalRecoverySnapshot({
    version: 1,
    rowEncodingVersion: 1,
    identity,
    selection: { baselineId: "baseline", effectSetIds: ["rebase", "noop"] },
    tables: localTableNames.map((name) => ({
      name,
      rows:
        name === "local_image_upload"
          ? [
              {
                filename: ["text", filename(13)],
                byte_length: ["integer", "3"],
                sha256: ["text", "a".repeat(64)],
                state: ["text", "pending"],
                created_at: ["integer", "9007199254740993"],
                installed_at: ["null"],
                completed_at: ["null"],
                error: ["null"],
                abandoned_at: ["null"],
                abandon_reason: ["null"],
              },
            ]
          : [],
    })),
  });
  const executions = await describeSharedRecoveryExecutions({
    checkpoint: shared.checkpoint,
    sharedHistory: shared.payload,
    selection: {
      baselineId: "baseline",
      effectSets: [
        { id: "rebase", rootId: "root", executionCount: 2 },
        { id: "noop", rootId: "root", executionCount: 1 },
      ],
    },
    effectSets: [group("rebase", 10), group("noop")],
  });
  const provenance = {
    deviceId: "first-device",
    epochId: identity.epochId,
    schemaId: identity.schemaId,
    hlc: "opaque:first-record",
  };
  const originals = await describeSharedRecoveryActions({
    checkpoint: executions.checkpoint,
    executions: executions.payload,
    sharedHistory: shared.payload,
    selection: { actionIds: ["root", "child", "skipped"] },
    actions: [
      { ...root, rootId: "root", parentId: null, generated, seq: "1", ...provenance },
      {
        id: "child",
        rootId: "root",
        parentId: "root",
        kind: "future.child",
        contractVersion: 99,
        input: { ref: reference(11) },
        generated: {},
        seq: "2",
        ...provenance,
      },
      {
        id: "skipped",
        rootId: "root",
        parentId: "root",
        kind: "future.skipped",
        contractVersion: 99,
        input: { ref: reference(12) },
        generated: {},
        seq: "9007199254740993",
        ...provenance,
      },
    ],
  });
  const sets = [],
    inventory = [],
    images = [];
  for (const [id, source, before, after, child] of [
    ["origin", "origin", 4, 5, 9],
    ["noop", "authoritative", undefined, undefined, undefined],
    ["superseded", "rebase", 6, 7, 8],
    ["rebase", "rebase", 1, 2, 10],
  ] as const) {
    const fx = before === undefined ? [] : effects(before, after!);
    const history = await describeSharedRecoveryHistory(
      {
        baseline: { id: `ctx-${id}`, projection: projection(before) },
        effectSets: [{ id, effects: fx }],
      },
      identity,
      { baselineId: `ctx-${id}`, effectSets: [{ id, effectCount: fx.length }] },
    );
    const run = await describeSharedRecoveryExecutions({
      checkpoint: history.checkpoint,
      sharedHistory: history.payload,
      selection: {
        baselineId: `ctx-${id}`,
        effectSets: [{ id, rootId: "root", executionCount: child === undefined ? 1 : 2 }],
      },
      effectSets: [group(id, child)],
    });
    sets.push({
      id,
      rootId: "root",
      source: source as SharedRecoveryEffectSetSource,
      history: history.payload,
      executions: run.payload,
    });
    inventory.push({
      id,
      rootId: "root",
      source: source as SharedRecoveryEffectSetSource,
      baselineId: `ctx-${id}`,
      effectCount: fx.length,
      executionCount: child === undefined ? 1 : 2,
    });
    images.push({
      id,
      history: {
        baseline: {
          id: `ctx-${id}`,
          manifest: manifest(...(before === undefined ? [] : [before])),
        },
        effectSets: [
          {
            id,
            manifest: manifest(
              0,
              ...(child === undefined ? [] : [before!, after!, child]),
              ...(id === "origin" ? [14] : []),
            ),
          },
        ],
      },
    });
  }
  const retained = await describeSharedRecoveryRetainedHistory({
    checkpoint: originals.checkpoint,
    selection: { effectSets: inventory },
    effectSets: sets,
    originals: originals.payload,
    executions: executions.payload,
    sharedHistory: shared.payload,
  });
  const assets = await describeRecoveryAssets({
    binding: { checkpoint: shared.checkpoint, localCheckpoint: local.checkpoint },
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    history: {
      baseline: { id: "baseline", manifest: manifest(1) },
      effectSets: [
        { id: "rebase", manifest: manifest(0, 1, 2, 10) },
        { id: "noop", manifest: manifest(0, 15) },
      ],
    },
  });
  return clone({
    binding: { checkpoint: retained.checkpoint, localCheckpoint: local.checkpoint },
    assetCheckpoint: assets.checkpoint,
    history: { effectSets: images },
    originalImages: manifest(0, 11, 12, 16),
    localSnapshot: local.snapshot,
    sharedHistory: shared.payload,
    executions: executions.payload,
    originalActions: originals.payload,
    retainedHistory: retained.payload,
    currentAssets: assets.payload,
  });
}
