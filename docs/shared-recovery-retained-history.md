# Retained recovery history

Retained recovery history preserves origin, superseded rebase and authoritative
effect sets for roots in a selected recovery checkpoint. Each run keeps its own
complete before-state, full row effects and execution records. Deselected runs
remain available without applying them to the selected materialization.

Import these helpers from `@kozane/core/recovery`. They prepare and validate data
without invoking action handlers or writing the live database.

## Prepare the inventory

Establish `SharedRecoveryRetainedSelection` independently of the incoming payload.
Its ordered `effectSets` entries contain `id`, `rootId`, `source`, `baselineId`,
`effectCount` and `executionCount`. Source values are `origin`, `rebase` and
`authoritative`. These labels describe trusted provenance. They do not grant
authority or select a synchronization policy.

Include every set selected by the current original-action checkpoint. Its root,
effect count and execution count must match that checkpoint. Other retained sets
must belong to the same selected roots. Inventory order defines canonical archive
order. The selected shared history defines materialization order separately.

Supply one `SharedRecoveryRetainedSet` per inventory entry. Its `history` is a
one-set `SharedRecoveryHistoryPayload` with a complete baseline for that run.
Its `executions` is the corresponding one-set `SharedRecoveryExecutionHistory`.
Both use the complete host checkpoint identity. Their baseline ID and counts
must match the inventory.

Prepare a description from the trusted sources and retained runs.

```ts
const retained = await describeSharedRecoveryRetainedHistory({
  checkpoint: originals.checkpoint,
  selection: retainedSelection,
  effectSets: retainedRuns,
  originals: originals.payload,
  executions: selectedExecutions.payload,
  sharedHistory: selectedHistory.payload,
});
```

The result has an immutable `payload` and `checkpoint`. The descriptor binds the
original-action checkpoint, retained inventory, canonical UTF-8 byte length and
SHA-256 hash. Preserve that descriptor independently of the payload.

Preparation checks the current original, execution and shared hashes. It also
checks each retained run against its own shared descriptor and original action
identities. Original root inputs and complete provider maps remain stable.
Child inputs and used bindings may differ between runs. Unknown kinds and
positive contract versions remain data.

For selected runs, row effects and execution records must exactly match the
current sources. Their complete before-states must match the selected
materialization at that point. Every run checks full before images. Deselected
runs use their own contexts and do not advance the current materialization.

## Verify before using the payload

Call `requireSharedRecoveryRetainedCheckpoint(input, checkpoint,
expectedIdentity, originals, executions, sharedHistory)` with independently
trusted expectations and all three current sources. It copies inputs before
hashing and checks identity, inventory, source relationships and contents.

`parseSharedRecoveryRetainedHistory` checks structure and reconstruction without
establishing authenticity. `parseSharedRecoveryRetainedCheckpoint` permits known
historical schemas as metadata. Payloads require the bundled schema.

Use `validateSharedRecoveryRetainedHistory(createDatabase, input, checkpoint,
expectedIdentity, originals, executions, sharedHistory)` to also check SQL
representability. The factory runs only after content verification. Supply a
separate empty canonical database for each call and dispose of every database
through the host.

Validation checks the complete before and final after projection of every run
in separate databases. It enforces constraints and exact tagged-cell readback,
then rolls back temporary rows and trigger changes before success. A baseline-only
archive validates its current baseline once. These endpoint checks do not execute
handlers or install rows.

## Collect image requirements

Supply `SharedRecoveryRetainedImages` with one `{ id, history }` entry per retained
set in inventory order. Each `history` contains that run's baseline manifest and
one effect-set manifest.

`sharedRecoveryRetainedAssetManifest(payload, images)` checks baseline images,
all full before and after images, and actual root and child invocation inputs
for every run. This includes invocation-only images from deselected executions.
It preserves extra requirements and refuses conflicting immutable image
identities. Check first-recorded inputs separately with
`sharedRecoveryActionAssetManifest`. Merge these requirements with the current
shared and local checkpoint manifest. A baseline-only archive adds no per-run
requirements.

The collector checks metadata. Physical byte verification and protection remain
host responsibilities.

[Retained asset checkpoints](retained-recovery-asset-checkpoints.md) bind per-run
manifests, original inputs and current shared/local requirements to the exact
retained and current asset descriptors. They verify complete source contents and
independent coverage before preparing the combined manifest.

## Current scope

These helpers cover roots named by the current selected execution checkpoint.
Trusted descriptors can be retained in the local catalog described below.
The Node host can also retain
[saved payload files](shared-recovery-retained-payloads.md).
The [image workflow](recovery-checkpoint-images.md#check-saved-retained-run-images)
can protect requirements from the saved retained manifests. Roots outside that
checkpoint and complete recovery
bundle publication remain pending. The production log format and authority policy
remain subject to the [adapter verification gate](action-capture-prototype.md).

[Action archives](shared-recovery-action-archives.md) prepare original records
for additional roots. Connecting their executions and effects to this retained
history format remains pending.

## Retain trusted descriptors

Migration 0032 adds `local_recovery_retained_history`. Register descriptors
established by trusted capture with
`rememberSharedRecoveryRetainedCheckpoint(db, checkpoint)`. The transaction-bound
variant is `rememberSharedRecoveryRetainedCheckpointInTx`.

Registration requires matching original-action, execution, shared and local
catalog records. It stores the retained descriptor and exact original local
descriptor under the workspace, device, epoch and checkpoint key. Nested
descriptors bind the other three original sources. Repeating identical metadata
preserves its registration timestamp. Changed contents, inventory or bindings
under the same key are refused, including coherent source replacement.

Do not register expectations solely because they accompanied received payloads.
Registration stores trusted metadata without verifying payload bytes, reserving
images or publishing a complete bundle.

`readSharedRecoveryRetainedCheckpoint`,
`inspectSharedRecoveryRetainedCheckpoint` and
`parseSharedRecoveryRetainedCheckpointRecord` return an immutable `binding` with
`checkpoint` and `localCheckpoint`. They validate nested descriptor and row
identities without converting registration timestamps to JavaScript dates.
Known historical and orphaned expectations remain inspectable. No source
foreign keys or automatic expiration remove them.

Use `requireStoredSharedRecoveryRetainedCheckpoint(catalog, input,
expectedIdentity, originals, executions, sharedHistory)` for catalog-backed
content verification. It owns all inputs before the first catalog read, resolves
trusted expectations in one consistent read boundary and hashes outside that
boundary. Before returning, it rechecks all five exact original bindings in a
second consistent boundary. Missing, changed or coherently rebound sources cause
failure. Descriptor whitespace and unrelated registrations do not alter an
expectation.

Shared capture and replacement exclude this tenth local table. Local snapshots
retain its exact rows and timestamps. Isolated local validation parses every
nested descriptor before allocating SQL. JSON export version 24 preserves current,
historical and orphaned records. Earlier supported dumps import with an empty
retained-history catalog when absent. Imports validate metadata without loading
retained payloads or installing history.
