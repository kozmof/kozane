# Run archive asset checkpoints

Run archive asset checkpoints bind image requirements to broader archived runs
and first-recorded actions. They preserve each run's manifests beside the current
shared and local requirements. Import the helpers from `@kozane/core/recovery`.

## Prepare complete requirements

Supply the exact [run archive binding](shared-recovery-run-archives.md#retain-trusted-run-descriptors)
and [current asset descriptor](recovery-asset-checkpoints.md). Both must retain
the same original shared and local expectations. The run binding also anchors
the original-action archive, current originals and selected executions.

`history` uses `SharedRecoveryRetainedImages`. Include one entry per run inventory
ID in inventory order. Each entry contains that run's baseline manifest and one
effect-set manifest. Their IDs must match the trusted inventory. Image entry
order within a manifest is canonicalized independently of run inventory order.

Supply `originalImages` with requirements from every first-recorded input in the
broader action archive. Include nested and skipped children and actions that
never execute in any retained run. Extra host requirements may occur in these
manifests. Conflicting immutable image identities are refused across all sources.

Prepare a description using all seven source payloads.

```ts
const runAssets = await describeRunArchiveAssets({
  binding: runBinding,
  assetCheckpoint: currentAssets.checkpoint,
  history: runImages,
  originalImages,
  localSnapshot: local.snapshot,
  sharedHistory: shared.payload,
  executions: executions.payload,
  originalActions: originals.payload,
  actionArchive: actionArchive.payload,
  runArchive: runs.payload,
  currentAssets: currentAssets.payload,
});
```

The immutable result contains `payload` and `checkpoint`. Preserve the descriptor
independently of received payloads. It binds the original run and local
expectations, current asset descriptor, canonical UTF-8 byte length and SHA-256
hash. The payload retains per-run manifests, broader original-input requirements
and their combined manifest.

Preparation verifies all seven source contents against their descriptors. Every
run keeps its own complete context and independently reconstructs its effects.
Selected runs must retain the current materialization. Original root inputs and
complete provider maps remain exact, while actual child inputs may differ.

## Check independent coverage

Each run's baseline manifest must cover its complete before-state. Its effect-set
manifest must cover all full before and after images and actual root and child
inputs. These checks include superseded runs, nested and skipped executions,
zero-effect sets and no-op children. Another run's manifest cannot supply a
missing requirement.

`originalImages` must independently cover every archived original input. An image
that appears in an executed run still needs first-record coverage. Inputs that
never execute remain required too.

Current asset metadata must retain per-set selected execution coverage. A
baseline manifest, broader run manifest or combined manifest cannot replace a
selected set's missing invocation requirement.

The combined manifest must exactly equal the union of current asset requirements,
broader original-input requirements and all per-run manifests. Current local-only
images, pending upload requirements and extra host requirements survive the
merge. Combined-only additions and missing source requirements cause failure.

A checkpoint without selected runs may retain broader originals and independent
runs. An empty run inventory still keeps all archived original inputs plus the
current baseline and local requirements. An archived root alone does not
establish whether it has executed or how many runs must exist.

## Verify a received payload

Call `requireRunArchiveAssetCheckpoint(input, checkpoint, expectedIdentity,
sources)` with an independently trusted descriptor. `sources` has the seven
payload fields shown above and uses `RunArchiveAssetSources`.

Verification owns all metadata and sources before hashing. It checks the complete
host identity, exact source bindings, canonical contents, every source hash and
recomputed independent coverage. Changed inventories, source labels, original
local bindings or current asset descriptors cause failure.

`parseRunArchiveAssetPayload` checks canonical structure and declared requirements
without establishing authenticity or actual coverage.
`parseRunArchiveAssetCheckpoint` keeps known historical descriptors readable as
metadata. Actual payload preparation and verification require the bundled schema.
Unknown action kinds and positive contract versions remain data.

## Current scope

These helpers prepare metadata without SQL validation, file publication, physical
image verification or reservations. Use the run archive validator or
[saved run loader](shared-recovery-run-archive-payloads.md) to validate independent
SQL endpoints separately.

Trusted descriptors can be registered in the catalog described below. The Node
host can retain [saved manifest files](run-archive-asset-payloads.md). Broader image
protection and complete bundle publication remain pending. Existing current and
selected-root retained asset formats stay at version 1 and retain their existing
scope.

## Retain trusted descriptors

Migration 0036 adds `local_recovery_run_assets`. Register trusted expectations
with `rememberRunArchiveAssetCheckpoint(db, checkpoint)`. Use
`rememberRunArchiveAssetCheckpointInTx` for a host-owned transaction. Registration
stores the complete descriptor and all seven original source bindings.

All seven source catalogs must be present and match those expectations. Repeating
the same descriptor preserves its registration timestamp. Changed contents,
inventories or bindings under the same workspace, device, epoch and checkpoint
key are refused. The result contains `checkpoint` and `changed`. Do not register
an expectation solely because it accompanied received data.

`readRunArchiveAssetCheckpoint`, `inspectRunArchiveAssetCheckpoint` and
`parseRunArchiveAssetCheckpointRecord` return immutable descriptors. They validate
row identity and nested metadata without converting registration timestamps to
JavaScript dates. Historical and orphaned records remain inspectable. There are
no source foreign keys, automatic expiration or deletion helpers.

Call `requireStoredRunArchiveAssetCheckpoint(catalog, input, expectedIdentity,
sources)` to verify contents against the catalog. It owns the payload and all
seven sources before the first read. It resolves the trusted descriptor and all
source bindings in one consistent read boundary, then verifies hashes and exact
coverage outside that boundary. Before success it rechecks all eight exact
original expectations in a second consistent read boundary. Missing, changed or
coherently rebound records cause failure. Equivalent descriptor formatting and
unrelated registrations do not change an expectation.

Shared capture and replacement exclude this fourteenth local table. Local
snapshots preserve its exact rows and timestamps. Isolated local validation
parses every nested descriptor before allocating SQL. JSON export version 26
preserves current, historical and orphaned metadata. Earlier supported dumps
import with an empty catalog when absent. Import validates metadata without
loading manifest payloads or installing images. The catalog stores expectations
without manifest payloads, image bytes or physical image protection. Manifest
files use [separate host storage](run-archive-asset-payloads.md).
