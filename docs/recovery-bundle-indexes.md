# Recovery bundle indexes

A recovery bundle index binds eight payloads and their image requirements to one
checkpoint. Import the helpers from `@kozane/core/recovery` after preparing a
[broader run-manifest descriptor](run-archive-asset-checkpoints.md).

## Prepare an inventory

Establish complete root, action and run inventories before preparing the source
descriptors. Index preparation preserves those trusted expectations and verifies
all declared contents. It does not discover omitted roots or runs.

Supply the independently trusted run-manifest checkpoint and all eight payloads.
Use the original local snapshot, including absent taskspaces and pending local
operations. A matching shared history cannot replace a missing local snapshot.

```ts
const bundle = await describeRecoveryBundleIndex(runAssets.checkpoint, {
  localSnapshot: local.snapshot,
  sharedHistory: shared.payload,
  executions: executions.payload,
  originalActions: originals.payload,
  actionArchive: actionArchive.payload,
  runArchive: runs.payload,
  currentAssets: currentAssets.payload,
  runAssets: runAssets.payload,
});
```

The immutable result contains `index` and `checkpoint`. Preparation owns every
source before hashing. It verifies all eight canonical contents against the
original descriptors and checks complete manifest coverage. Each run keeps its
own baseline, full effects and actual invocation requirements. First-recorded
inputs retain separate coverage, including children that never execute. Current
per-set requirements, local images, pending uploads and host extras survive the
combined manifest.

The index has one reference for each payload in this fixed order.

| Kind | Referenced contents |
| --- | --- |
| `local-snapshot` | Exact original local rows and shared selection |
| `shared-history` | Current shared baseline and selected row effects |
| `executions` | Selected executions and effect attribution |
| `original-actions` | Current first-recorded action inputs and bindings |
| `action-archive` | Broader root and original-action inventories |
| `run-archive` | Broader runs with independent before-states and complete records |
| `current-assets` | Current shared, selected execution and local requirements |
| `run-assets` | Broader per-run and original-input requirements and their exact union |

Each reference contains `kind`, `byteLength` and lowercase `sha256`. References
must match the original nested descriptors exactly. Missing, duplicate, reordered
or additional references cause failure. Callers cannot supply filenames or paths.
The index also retains the exact `runAssetCheckpoint` and combined image
`manifest`.

The bundle descriptor binds that original run-manifest checkpoint, the canonical
UTF-8 byte length and SHA-256 hash of `JSON.stringify(index)` without a newline.
Preserve the descriptor independently of received index data. Do not establish
trust solely from a descriptor carried with an incoming index.

## Verify received metadata

Call `requireRecoveryBundleCheckpoint(index, checkpoint, expectedIdentity,
sources)` with independently trusted expectations. `sources` uses
`RecoveryBundleSources` and contains the eight payload fields shown above.

Verification owns the index, expectations, full host identity and every source
before hashing. It checks the index hash and bindings, verifies every source hash
and independently recomputes image coverage. Image requirements must exactly
match the verified broader manifest. Adding an image solely to the bundle index
or omitting a declared requirement causes failure even if its index hash is
recomputed.

`parseRecoveryBundleIndex` checks the closed inventory and canonical image
metadata. `parseRecoveryBundleCheckpoint` checks descriptor metadata. Both keep
known historical expectations inspectable. Parsing alone does not establish
source authenticity or coverage. Preparation and verification require the
bundled schema. Unknown action kinds and positive contract versions remain data.

## Continue bundle assembly

These helpers prepare and verify metadata. They perform no SQL validation,
physical image reads, file publication, installation or activation.

The Node host can validate [saved broader manifests](run-archive-asset-payloads.md)
and their seven saved sources, including isolated SQL checks of exact source rows
and every run endpoint. Use the
[broader image workflow](recovery-checkpoint-images.md#check-saved-broader-run-images)
to commit image protection and verify physical bytes against all eight original
bindings and saved files. Neither an index nor a retained image owner authorizes
publication of an incomplete bundle. Complete bundle publication and durable
installation remain pending.
