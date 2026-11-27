# Retained recovery asset checkpoints

Retained recovery asset checkpoints bind image requirements to origin,
superseded rebase and authoritative runs. They preserve each run's manifests
beside the combined requirements for original actions and the current checkpoint.

Import these helpers from `@kozane/core/recovery`. They prepare and verify
metadata without reading image bytes, reserving files or running action handlers.

## Prepare the manifests

Supply the exact [retained-history binding](shared-recovery-retained-history.md#retain-trusted-descriptors)
and [current asset descriptor](recovery-asset-checkpoints.md). Both must name
the same original shared and local expectations. Retained metadata also binds
the original-action and selected-execution descriptors.

`history` uses `SharedRecoveryRetainedImages`. Include one entry per retained
inventory ID in inventory order. Each entry contains that run's baseline manifest
and one effect-set manifest. Their IDs must match the separately trusted retained
inventory. `parseSharedRecoveryRetainedImages` owns this metadata without checking
its selection or actual coverage.

Supply `originalImages` with image requirements from every first-recorded input,
including original child arguments and skipped children. Extra host requirements
may be recorded in these manifests. Conflicting immutable image identities are
refused across all sources.

Prepare a description using all six source payloads.

```ts
const retainedAssets = await describeRetainedRecoveryAssets({
  binding: retainedBinding,
  assetCheckpoint: currentAssets.checkpoint,
  history: retainedImages,
  originalImages,
  localSnapshot: local.snapshot,
  sharedHistory: shared.payload,
  executions: executions.payload,
  originalActions: originals.payload,
  retainedHistory: retained.payload,
  currentAssets: currentAssets.payload,
});
```

The result has an immutable `payload` and `checkpoint`. Preserve the descriptor
independently of the payload. It binds the original retained and local
expectations, current asset descriptor, canonical UTF-8 byte length and SHA-256
hash. The payload stores per-run manifests, original-input requirements and their
combined manifest.

Preparation verifies the actual retained, original-action, execution, shared,
local and current asset contents against their descriptors. Each run keeps its
complete context and independently reconstructs its row effects. Selected runs
must match the current materialization. Original root inputs and full provider
maps remain stable, while resolved child inputs may differ.

## Check exact coverage

Each retained baseline manifest must cover that run's complete before-state.
Its effect-set manifest must cover every full before and after image and actual
root and child invocation input. These checks include superseded runs,
zero-effect sets and no-op children.

`originalImages` must cover every original input independently. The current
asset payload must also retain per-set selected execution coverage, including
no-op inputs. A missing requirement cannot be supplied by another run's manifest
or by the combined manifest alone.

The combined manifest must exactly equal the union of current asset requirements,
original-input requirements and all per-run manifests. This includes current
local-only images and extra host requirements. A baseline-only archive adds no
per-run requirements and keeps the current shared and local images.

## Verify a received payload

Call `requireRetainedRecoveryAssetCheckpoint(input, checkpoint, expectedIdentity,
sources)` with independently trusted expectations. `sources` has the six payload
fields shown above and uses `RetainedRecoveryAssetSources`.

Verification owns all metadata and sources before hashing. It checks the full
host identity, both source bindings, canonical contents, all source hashes and
recomputed exact coverage. Changed source labels, inventories, original local
bindings or current asset descriptors cause failure.

`parseRetainedRecoveryAssetPayload` checks canonical structure and declared
requirements without establishing authenticity or actual coverage.
`parseRetainedRecoveryAssetCheckpoint` keeps known historical descriptors
inspectable as metadata. Payload preparation and verification require the bundled
schema. Unknown action kinds and positive contract versions remain data.

## Current scope

Preparation helpers perform no SQL validation, file publication or physical image
verification. They cover the retained roots in the selected checkpoint. Trusted
descriptors can be registered in the catalog described below. The Node host can
also retain [saved manifest files](retained-recovery-asset-payloads.md) and
[protect their images](recovery-checkpoint-images.md#check-saved-retained-run-images).
[Run archive asset checkpoints](run-archive-asset-checkpoints.md) prepare
requirements for additional roots in a separate format. Complete bundle
publication remains pending.
The existing current asset payload format stays at version 1.

## Retain trusted descriptors

Migration 0033 adds `local_recovery_retained_assets`. Register expectations from
trusted preparation with `rememberRetainedRecoveryAssetCheckpoint(db, checkpoint)`.
Use `rememberRetainedRecoveryAssetCheckpointInTx` for a host-owned transaction.
Registration stores the complete descriptor, including the exact original
retained-history, local and current asset bindings.

All six source catalogs must be present and match the nested expectations.
Repeating the same descriptor preserves its registration timestamp. Changed
contents, inventories or bindings under the same workspace, device, epoch and
checkpoint key are refused. The result contains `checkpoint` and `changed`.
Do not register an expectation solely because it accompanied received data.

`readRetainedRecoveryAssetCheckpoint`, `inspectRetainedRecoveryAssetCheckpoint`
and `parseRetainedRecoveryAssetCheckpointRecord` return the immutable descriptor.
They validate row identity and nested metadata without converting registration
timestamps to JavaScript dates. Historical and orphaned records remain
inspectable. There are no source foreign keys, automatic expiration or deletion
helpers.

Call `requireStoredRetainedRecoveryAssetCheckpoint(catalog, input,
expectedIdentity, sources)` to verify contents against the catalog. It owns the
payload and all six sources before the first catalog read. It resolves the
trusted descriptor and all source bindings in one consistent read boundary,
then verifies hashes and exact coverage outside that boundary. Before success,
it rechecks all seven exact original expectations in a second consistent read
boundary. Missing, changed or coherently rebound records cause failure.
Equivalent descriptor formatting and unrelated registrations do not change an
expectation.

Shared capture and replacement exclude this eleventh local table. Local
snapshots preserve its exact rows and timestamps. Isolated local validation
parses every nested descriptor before allocating SQL. JSON export version 26
preserves current, historical and orphaned metadata. Earlier supported dumps
import with an empty catalog when absent. Import validates metadata without
loading manifest payloads or installing images.

The catalog stores expectations. Manifest files use
[separate host storage](retained-recovery-asset-payloads.md). Physical image
verification, protection and complete bundle publication remain separate requirements.
