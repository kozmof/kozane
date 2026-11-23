/** Trusted first-record fixtures include roots outside the current materialization. */
import {
  retainedRecoveryAssetFixture,
  identity,
  reference,
  clone,
} from "./retained-recovery-assets.js";
export async function sharedRecoveryActionArchiveFixture() {
  const f = await retainedRecoveryAssetFixture(),
    current = clone(f.originalActions.actions),
    provenance = {
      deviceId: "other-device",
      epochId: identity.epochId,
      schemaId: identity.schemaId,
      hlc: "opaque:unselected",
    };
  const generated = {
    child: { type: "child-id", value: "detached-child" },
    grand: { type: "child-id", value: "detached-grand" },
    skipped: { type: "child-id", value: "detached-skipped" },
    unused: { type: "entity-id", value: "unused" },
    clock: { type: "clock", value: -100 },
  };
  const detached = [
    {
      id: "detached",
      rootId: "detached",
      parentId: null,
      kind: "future.unselected",
      contractVersion: 77,
      input: { ref: reference(17), text: '\ufeff{"exact":true}\0🪁' },
      generated,
      seq: "3",
      ...provenance,
    },
    {
      id: "detached-child",
      rootId: "detached",
      parentId: "detached",
      kind: "future.child",
      contractVersion: 77,
      input: { ref: reference(18) },
      generated: { grand: generated.grand },
      seq: "4",
      ...provenance,
    },
    {
      id: "detached-grand",
      rootId: "detached",
      parentId: "detached-child",
      kind: "future.grand",
      contractVersion: 77,
      input: { ref: reference(19) },
      generated: {},
      seq: "5",
      ...provenance,
    },
    {
      id: "detached-skipped",
      rootId: "detached",
      parentId: "detached",
      kind: "future.skipped",
      contractVersion: 77,
      input: { ref: reference(20) },
      generated: {},
      seq: "9223372036854775807",
      ...provenance,
    },
  ];
  const actions = [...current.slice(0, 2), ...detached.slice(0, 3), current[2], detached[3]];
  return {
    localCheckpoint: f.binding.localCheckpoint,
    checkpoint: f.binding.checkpoint.checkpoint,
    selection: { rootIds: ["root", "detached"], actionIds: actions.map((action) => action.id) },
    actions,
    originals: f.originalActions,
    executions: f.executions,
    sharedHistory: f.sharedHistory,
  };
}
