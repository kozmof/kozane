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

The helpers perform no SQL validation, catalog registration, file publication or
physical image verification. They cover the retained roots in the selected
checkpoint. Durable retained-manifest catalogs and payload files, protected image
integration, additional roots and complete bundle publication remain pending.
The existing current asset payload format stays at version 1.
