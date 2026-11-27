# Recovery run archives

Run archives prepare origin, superseded rebase and authoritative runs for roots
outside the current materialization. Each run keeps its complete before-state,
full row effects and actual execution records. Import the helpers from
`@kozane/core/recovery`.

## Establish the inventory

Prepare a [trusted action archive](shared-recovery-action-archives.md) first.
Supply its descriptor as `checkpoint` and its original payload as `actionArchive`.
Also supply the matching current `originals`, `executions` and `sharedHistory`
payloads. These four payloads form `SharedRecoveryRunArchiveSources`.

Establish `SharedRecoveryRetainedSelection` independently of incoming contents.
Its ordered `effectSets` entries contain `id`, `rootId`, `source`, `baselineId`,
`effectCount` and `executionCount`. Source values are `origin`, `rebase` and
`authoritative`. These labels preserve provenance without granting authority or
classifying work as accepted, rejected or pending.

Every inventory root must occur in the trusted action archive. Include all sets
selected by the current checkpoint with their exact roots and counts. The host
establishes which additional runs must be present. An archived root alone does
not establish how many runs exist or require that it has already executed.
Inventory order determines canonical archive order. Current shared history
continues to determine materialization order separately.

Supply one `SharedRecoveryRetainedSet` per entry. Its `history` is a one-set
`SharedRecoveryHistoryPayload` containing that run's complete baseline and row
effects. Its `executions` is the corresponding one-set
`SharedRecoveryExecutionHistory`. The full host identity, baseline ID and counts
must agree with the trusted inventory.

Prepare a run archive from complete records and all four sources.

```ts
const sources = {
  actionArchive: archive.payload,
  originals: originals.payload,
  executions: selectedExecutions.payload,
  sharedHistory: selectedHistory.payload,
};
const runs = await describeSharedRecoveryRunArchive({
  ...sources,
  checkpoint: archive.checkpoint,
  selection: runSelection,
  effectSets: retainedRuns,
});
```

The immutable result contains `payload` and `checkpoint`. The descriptor binds
the action archive expectation, complete run inventory, canonical UTF-8 byte
length and SHA-256 hash. Preserve it independently of received payloads.

Preparation verifies all four source contents and each run's shared descriptor.
Every execution must match an archived original identity, parent, kind and
contract version. Root inputs and complete provider maps remain exact. Child
inputs and used bindings may differ between runs. Nested children and children
skipped by current runs may occur in earlier runs. Unknown kinds and positive
versions remain data.

Current selected runs must retain exact effects, execution records and complete
before-states. Additional runs reconstruct independently and never advance the
current materialization. Every reconstruction checks full before images and
ordered effect attribution. A checkpoint without selected actions may still
have archived original records and runs.

## Verify and validate

Call `requireSharedRecoveryRunArchiveCheckpoint(input, checkpoint,
expectedIdentity, sources)` with an independently trusted descriptor. It owns all
inputs before hashing and checks identity, inventories, source bindings, exact
current contents and each nested source hash. Truncation, changed provenance and
changed bytes cause failure even when current rows remain unchanged.

`parseSharedRecoveryRunArchive` checks structure and owns transport data without
establishing authenticity. It canonicalizes run transport order to the inventory
and rejects duplicate or missing sets. Accessors and serialization hooks are
refused without invocation. `parseSharedRecoveryRunArchiveCheckpoint` keeps known
historical descriptors readable as metadata. Actual run rows require the bundled
schema.

Use `validateSharedRecoveryRunArchive(createValidationDatabase, input,
checkpoint, expectedIdentity, sources)` for SQL validation. It verifies contents
before requesting databases, then validates every run's full before and final
after state in separate empty canonical databases. When no runs are selected,
it also validates the current baseline. An empty archive validates that baseline
once.

The host owns validation database creation and disposal. Validation compares
exact tagged read-back and rolls temporary rows and trigger changes back before
success. Cleanup and outer commit failures refuse success. Validation never
selects archived runs, invokes handlers or installs live rows.

## Retain trusted run descriptors

Register independently established expectations with
`rememberSharedRecoveryRunArchiveCheckpoint(db, checkpoint)`. Use
`rememberSharedRecoveryRunArchiveCheckpointInTx` to share a caller's transaction.
Registration requires all five matching original source catalogs, including the
action archive. It retains the exact original local descriptor alongside the run
expectation in `local_recovery_run_archives`.

The workspace, device, epoch and checkpoint key is immutable. Identical
registration preserves its timestamp. Changed contents, inventory or source
bindings require a new key. Registration stores metadata without payload bytes,
SQL endpoint validation or image protection.

Use `requireStoredSharedRecoveryRunArchiveCheckpoint(catalog, input,
expectedIdentity, sources)` for catalog-backed content verification. It owns all
inputs before the first catalog read, resolves the run expectation and all five
sources in one consistent read boundary, hashes outside it and rechecks all six
original expectations afterward. Missing, changed and coherently replaced
bindings refuse verification.

`readSharedRecoveryRunArchiveCheckpoint`,
`inspectSharedRecoveryRunArchiveCheckpoint` and
`parseSharedRecoveryRunArchiveCheckpointRecord` return the run descriptor and
its original local binding. Inspection keeps historical and orphaned metadata
readable without requiring live sources or converting timestamps through
JavaScript dates. No source foreign keys or automatic expiration remove records.

Migration 0035 adds this thirteenth local table. Shared replacement preserves it.
Exact local snapshots and JSON export version 26 retain its metadata. Local
validation parses every nested descriptor before SQL allocation. Import validates
catalog metadata without loading or installing run payloads.

## Collect image requirements

`sharedRecoveryRunArchiveAssetManifest(input, images)` accepts
`SharedRecoveryRetainedImages`. Its entries must follow the exact run inventory.
Each run requires independent coverage of its baseline, all row effects and
actual root and child inputs, including nested, skipped and zero-effect records.
Extra requirements survive the merge. Missing entries and conflicting immutable
image identities cause failure.

The collector checks metadata without reading bytes or reserving images. Current
shared/local requirements remain separate. First-recorded inputs, including
children that never execute, need the action archive's image collector too.
[Run archive asset checkpoints](run-archive-asset-checkpoints.md) bind these
requirements and all archived original inputs to the exact run and current asset
expectations. The Node host can retain
[saved broader manifests](run-archive-asset-payloads.md) after validating all seven
sources. The [broader image workflow](recovery-checkpoint-images.md#check-saved-broader-run-images)
reserves and verifies complete requirements.

## Current scope

Run archives are a separate version 1 format. Existing selected-root retained
history, catalogs and saved files retain their existing scope. Trusted run-archive
descriptors can be registered locally. The Node host can retain
[saved run payloads](shared-recovery-run-archive-payloads.md) after validating all
five saved sources and every run's SQL endpoints. The host can
[publish registered bundles](recovery-bundles.md) after validating all source
contents and protected images. Installation remains pending. Production capture
remains subject to the
[adapter verification gate](action-capture-prototype.md).
