/** Broader run fixtures preserve independent contexts and original action identities. */
import {
  describeSharedRecoveryActionArchive,
  describeSharedRecoveryHistory,
  describeSharedRecoveryExecutions,
  type SharedRecoveryEffectSetSource,
} from "@kozane/core/recovery";
import { sharedRecoveryActionArchiveFixture } from "./shared-recovery-action-archive.js";
import {
  retainedRecoveryAssetFixture,
  identity,
  reference,
  projection,
  effects,
  manifest,
  clone,
} from "./retained-recovery-assets.js";
export async function sharedRecoveryRunArchiveFixture() {
  const f = await retainedRecoveryAssetFixture(),
    original = await sharedRecoveryActionArchiveFixture(),
    archived = await describeSharedRecoveryActionArchive(original),
    effectSets = clone(f.retainedHistory.effectSets),
    inventory = clone(f.retainedHistory.selection.effectSets),
    images = clone(f.history);
  for (const [id, source, before, after, childRef, skipped] of [
    ["detached-origin", "origin", 21, 22, 18, true],
    ["detached-rebase", "rebase", 25, 26, 23, false],
    ["detached-authoritative", "authoritative", 29, undefined, 27, false],
  ] as const) {
    const root = archived.payload.actions.find((a) => a.id === "detached")!,
      child = archived.payload.actions.find((a) => a.id === "detached-child")!,
      grand = archived.payload.actions.find((a) => a.id === "detached-grand")!,
      skip = archived.payload.actions.find((a) => a.id === "detached-skipped")!;
    const invocation = {
      id: root.id,
      kind: root.kind,
      contractVersion: root.contractVersion,
      input: root.input,
    };
    const records = [
      {
        ...invocation,
        parentId: null,
        executionOrd: 0,
        generated: {
          child: root.generated.child,
          ...(skipped ? { skipped: root.generated.skipped } : {}),
        },
      },
      {
        id: child.id,
        kind: child.kind,
        contractVersion: child.contractVersion,
        input: { ref: reference(childRef) },
        parentId: root.id,
        executionOrd: 1,
        generated: { grand: root.generated.grand },
      },
      {
        id: grand.id,
        kind: grand.kind,
        contractVersion: grand.contractVersion,
        input: { ref: reference(childRef + 1) },
        parentId: child.id,
        executionOrd: 2,
        generated: {},
      },
      ...(skipped
        ? [
            {
              id: skip.id,
              kind: skip.kind,
              contractVersion: skip.contractVersion,
              input: skip.input,
              parentId: root.id,
              executionOrd: 3,
              generated: {},
            },
          ]
        : []),
    ];
    const fx = after === undefined ? [] : effects(before, after),
      history = await describeSharedRecoveryHistory(
        {
          baseline: { id: `ctx-${id}`, projection: projection(before) },
          effectSets: [{ id, effects: fx }],
        },
        identity,
        { baselineId: `ctx-${id}`, effectSets: [{ id, effectCount: fx.length }] },
      ),
      run = await describeSharedRecoveryExecutions({
        checkpoint: history.checkpoint,
        sharedHistory: history.payload,
        selection: {
          baselineId: `ctx-${id}`,
          effectSets: [{ id, rootId: root.id, executionCount: records.length }],
        },
        effectSets: [
          {
            id,
            invocation,
            generated: root.generated,
            executions: records,
            effects: fx.map(({ ord }) => ({
              ord,
              actionId: ord === 0 ? child.id : grand.id,
              executionOrd: ord === 0 ? 1 : 2,
            })),
          },
        ],
      });
    const set = {
        id,
        rootId: root.id,
        source: source as SharedRecoveryEffectSetSource,
        history: history.payload,
        executions: run.payload,
      },
      entry = {
        id,
        rootId: root.id,
        source: source as SharedRecoveryEffectSetSource,
        baselineId: `ctx-${id}`,
        effectCount: fx.length,
        executionCount: records.length,
      },
      image = {
        id,
        history: {
          baseline: { id: `ctx-${id}`, manifest: manifest(before) },
          effectSets: [
            {
              id,
              manifest: manifest(
                17,
                before,
                ...(after === undefined ? [] : [after]),
                childRef,
                childRef + 1,
                ...(skipped ? [20] : []),
                30,
              ),
            },
          ],
        },
      };
    effectSets.splice(1, 0, set);
    inventory.splice(1, 0, entry);
    images.effectSets.splice(1, 0, image);
  }
  return {
    localCheckpoint: original.localCheckpoint,
    checkpoint: archived.checkpoint,
    selection: { effectSets: inventory },
    effectSets,
    actionArchive: archived.payload,
    originals: original.originals,
    executions: original.executions,
    sharedHistory: original.sharedHistory,
    images,
  };
}
