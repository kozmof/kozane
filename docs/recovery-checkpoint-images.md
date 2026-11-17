# Images for saved recovery checkpoints

The Node host can protect images required by both saved checkpoint payloads.
Use `reserveRegisteredRecoveryCheckpointImages` and
`retainRegisteredRecoveryCheckpointImages` in
`lib/server/recovery-checkpoint-images.ts` after saving the matching
[local snapshot](local-recovery-payloads.md) and
[shared row history](shared-recovery-payloads.md).

## Prepare trusted requirements

Supply `root`, the trusted catalog `db`, the host's `expected` checkpoint identity
and a separate `createValidationDatabase` factory. Set `localMaxBytes` and
`sharedMaxBytes` to positive safe integers. Each limit bounds its payload's input
bytes. Parsing and validation require additional memory.

Supply `history` with a baseline and an ordered `effectSets` array. Each entry
contains an `id` and an image `manifest`. Obtain these manifests from complete
retained records, including original invocations. Keep their earlier image pins
until the recovery reservation commits.

The workflow copies identity and manifest metadata before awaiting work. It
loads and validates both saved payloads sequentially and requires the same
original local descriptor in both catalog bindings. The validation factory must
own a separate empty database and its disposal for each call.

The shared coverage check requires the baseline manifest to cover every image
reference in its rows. Each effect-set manifest must cover that set's full before
and after images, including intermediate and deleted references. Manifest IDs
must match the saved selection in order. Extra manifest entries remain required,
including invocation-only images in sets with no row effects.

Shared row history contains no invocation or execution records. Coverage checks
cannot infer their image requirements or authenticate host manifests. Retain
trusted complete records and their manifests separately.

Local requirements include active uploads and manifest owners from the saved
snapshot. All local identity records, including inactive ones, are checked for
conflicting immutable names when merging requirements.

## Reserve before verifying bytes

`reserveRegisteredRecoveryCheckpointImages` returns the original shared/local
`binding`, stable recovery `owner`, combined `manifest`, owner `state` and a
`changed` flag. It checks both catalog bindings and both published payload files
under the image writer lock before committing protection. Missing or changed
payload bytes and any temporary evidence refuse reservation. This operation
does not read image bytes.

The owner uses the same checkpoint key as the
[local payload image workflow](local-recovery-payloads.md#protect-checkpoint-images).
An existing owner can be reused only with the exact same manifest. Repeating a
reservation preserves its timestamps. Changed requirements cannot replace it,
and released owner IDs cannot be reused.

`retainRegisteredRecoveryCheckpointImages` first commits that reservation. A
separate writer transaction verifies every required live or archived image.
Archived bytes are accepted without reinstalling them. Catalog bindings and both
payload files are checked before and after image verification. Cleanup and
competing owner releases serialize with verification through the same lock.

Missing, unsafe or changed image bytes refuse success. Failed verification or
its final commit leaves the earlier pending protection intact. A failed recheck
of an already retained owner preserves its earlier record and protection.
Explicit retries verify image bytes again. Neither helper changes payload files,
installs images or releases earlier owners.

## Retain the checkpoint

Core also provides [content-bound recovery image requirements](recovery-asset-checkpoints.md)
for later manifest storage. They bind per-record requirements and the combined
manifest to the exact local/shared descriptor pair. This Node workflow continues
to receive host manifests directly and does not yet load those asset payloads.

Pending and retained recovery owners both protect their manifests during cleanup.
Release an owner only through an explicit ledger retirement decision after the
checkpoint is no longer needed. Earlier staging owners can be released after
the new reservation commits.

These operations protect image requirements for two saved payloads. Complete
action and execution retention, durable asset-manifest storage, complete bundle
publication and one-time installation remain pending. A retained image owner
does not serve as a bundle publication or activation receipt.
