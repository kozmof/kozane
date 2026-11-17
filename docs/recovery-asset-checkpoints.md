# Content-bound recovery image requirements

Core can bind image manifests to an exact pair of recovery checkpoints.
Use the asset payload helpers from `@kozane/core/recovery` to prepare requirements
for later durable bundle storage.

## Describe trusted requirements

Obtain the original local snapshot, shared row-history payload and their trusted
descriptor `binding`. Obtain each history manifest from complete retained
records, including original invocations. Describe the requirements after
establishing those expectations.

```ts
const assets = await describeRecoveryAssets({
  localSnapshot: local.snapshot,
  sharedHistory: shared.payload,
  binding: shared.binding,
  history,
});
```

The result contains an immutable `payload` and content `checkpoint`. The version
1 payload includes the original shared/local descriptor pair, the per-record
history manifests and the combined image manifest. Baseline and ordered
effect-set IDs must match both checkpoints. Shared expected effect counts remain
part of the descriptor binding.

The helper verifies both source payload hashes against that binding. It checks
baseline and full before and after image coverage, preserves extra host
requirements and merges active local snapshot requirements. Inactive local
identity records still refuse conflicting bytes under one name.

The asset descriptor includes the same binding, the UTF-8 byte length and the
SHA-256 digest of `JSON.stringify(payload)` with no added newline. Plain field
order and manifest entry order normalize to canonical bytes. Per-record
associations remain significant. Moving an invocation-only requirement between
records changes the digest even when the combined manifest stays identical.

Keep the expected asset descriptor independently from received payloads.
Describing received data does not establish trust. Description does not register
the descriptor in the database or save payload files.

## Verify received requirements

Supply the independently retained asset descriptor, the host's expected identity
and both original source payloads.

```ts
const payload = await requireRecoveryAssetCheckpoint(
  receivedAssets,
  expectedAssetCheckpoint,
  expectedIdentity,
  { localSnapshot: local.snapshot, sharedHistory: shared.payload },
);
```

Verification checks the full workspace, device, epoch, checkpoint and schema
identity and compares the original descriptor pair. It verifies the asset hash
and length, then verifies each source payload against its bound descriptor. It
recomputes row coverage and requires the exact combined manifest. Missing local
requirements and unexplained combined entries refuse success, including when
the supplied asset digest matches.

All inputs are copied before hashing begins. Caller mutation during asynchronous
hashing cannot change the owned result. Successful verification returns the
canonical immutable asset payload.

`parseRecoveryAssetPayload` validates plain transport, selected IDs, immutable
name consistency and inclusion of all supplied history requirements. Parsing
alone cannot establish coverage against source rows. `parseRecoveryAssetCheckpoint`
accepts known historical schemas as metadata. Actual payload preparation accepts
only the current bundled schema. Accessors and serialization hooks are refused
without invocation.

## Retain trusted asset descriptors

Migration 0029 adds the device-local `local_recovery_assets` catalog.
`rememberRecoveryAssetCheckpoint(db, checkpoint)` registers the trusted asset
expectation under its workspace, device, epoch and checkpoint key. Register the
original local and shared descriptors first. Both live records must match the
pair retained inside the asset descriptor.

The transaction-bound variant shares a host-owned commit. Registration takes
the writer lock before reading any binding. Repeating the same descriptor
preserves its registration timestamp. Changed asset hashes, lengths or original
bindings cannot replace an existing expectation under the same key.

`readRecoveryAssetCheckpoint`, `inspectRecoveryAssetCheckpoint` and
`parseRecoveryAssetCheckpointRecord` return validated immutable metadata without
converting timestamps to JavaScript dates. The table has no foreign keys to
shared rows or the original catalogs. Orphaned expectations therefore remain
readable for inspection after a source descriptor disappears. Reading them
provides no permission to load their payloads.

`requireStoredRecoveryAssetCheckpoint(catalog, input, expectedIdentity, contents)`
resolves the asset expectation and checks both live source bindings in one read
transaction. Supply the original local snapshot and shared row history through
`contents`. Input, identity and source payloads are copied before the first read.
Hashing and coverage checks run after that read transaction closes. All three
catalogs are rechecked before success. Removed or replaced bindings refuse a
result, while unrelated registrations and equivalent descriptor JSON formatting
remain allowed.

Local snapshots capture this seventh local table with exact tagged values.
Isolated local validation checks every nested asset descriptor before allocating
a database. Shared capture and replacement exclude the table. JSON version 19
includes these expectations and accepts supported versions 7 through 18 with
an empty asset catalog when omitted. Import validates descriptor shape, row
identity and the embedded pair without installing manifests or images. Orphaned
historical metadata remains available for review.

Registration stores a trusted expectation. It does not save the asset payload,
pin images, verify SQL values, enroll identities or publish a bundle. Register
only descriptors established through trusted host preparation. Received catalog
rows cannot establish their own expectations.

## Continue bundle preparation

These helpers verify content and image metadata. They perform no SQL validation
or image-byte reads. Validate SQL values in a separate database and use the
[saved checkpoint image workflow](recovery-checkpoint-images.md) to commit
protection before verifying live or archived image bytes.

Shared row history contains no action or execution records. Obtain complete
invocation requirements from trusted retained records and preserve their extra
manifest entries. A matching hash cannot authenticate those records or establish
that they are complete.

The Node host provides [saved recovery manifests](recovery-asset-payloads.md)
with immutable publication, read-only interruption inspection and bounded reads.
Both source payloads are validated before saving or returning manifests. The
image workflow accepts `assetMaxBytes` to load the registered saved manifests,
reserve their requirements and verify protected bytes while rechecking all three
bindings and files. Complete action and execution retention, complete bundle
publication, one-time installation and activation remain pending.
