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

## Current scope

These helpers cover roots named by the current selected execution checkpoint.
Durable retained-history catalogs and payload files, roots outside that
checkpoint, retained manifest storage and complete recovery bundle publication
remain pending. The production log format and authority policy remain subject
to the [adapter verification gate](action-capture-prototype.md).
