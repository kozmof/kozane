# Images for saved recovery checkpoints

The Node host can protect images required by saved recovery payloads and manifests.
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

Choose either registered saved manifests or host-supplied history manifests.
Supplying both `assetMaxBytes` and `history` is refused.

## Use registered saved manifests

Save the matching [asset payload](recovery-asset-payloads.md) and supply
`assetMaxBytes` as a positive safe integer. The workflow resolves its expectation
from the trusted asset catalog and loads its published bytes within that limit.

```ts
const retained = await retainRegisteredRecoveryCheckpointImages({
  root,
  db,
  expected,
  localMaxBytes,
  sharedMaxBytes,
  assetMaxBytes,
  createValidationDatabase,
});
```

Loading verifies the asset descriptor and both saved source payloads, including
isolated SQL validation and exact manifest coverage. The result adds the
original trusted `assetCheckpoint` beside the shared/local `binding`. Per-record
requirements remain covered by the asset payload hash even when their combined
image manifest would be unchanged.

The original asset, shared and local catalog bindings and all three saved files
are checked under the image writer lock before and after reservation. The same
checks surround image verification. Missing files, changed bytes, temporary
evidence and changed bindings refuse success. A new reservation rolls back if
owner publication changes a required binding. Earlier protection survives
failed loading or verification.

## Check saved execution images

Save the matching [execution payload](shared-recovery-execution-payloads.md) and
add `executionMaxBytes` to the registered saved-manifest path. The positive safe
integer limit bounds the execution file independently of the other payloads.
Supplying this option with host history manifests is refused.

```ts
const retained = await retainRegisteredRecoveryCheckpointImages({
  root,
  db,
  expected,
  localMaxBytes,
  sharedMaxBytes,
  assetMaxBytes,
  executionMaxBytes,
  createValidationDatabase,
});
```

Loading checks trusted execution contents and attribution, then requires each
effect-set manifest to cover its root and all child inputs. No-op children and
zero-effect roots remain covered. Entries in another set do not satisfy missing
coverage, even if the combined manifest contains the image.

The result adds the original `executionBinding`. All four original catalog
bindings and saved files are checked under the image writer lock before and
after reservation and byte verification. Changed execution metadata, missing or
changed execution bytes and temporary evidence refuse success. New reservations
roll back after a failed recheck. Earlier pending or retained protection survives
failed loading, verification or commits.

The asset descriptor and image owner format remain unchanged. Supply
`executionMaxBytes` for every call that requires this coverage. Neither record
serves as a durable receipt for execution coverage or complete bundle publication.

## Check saved original invocation images

Save the matching [original-action payload](shared-recovery-action-payloads.md)
and add `actionMaxBytes` with `executionMaxBytes` to the saved-manifest path.
The positive safe integer limit bounds original bytes independently. This option
requires the execution read limit and is refused with host history manifests.

```ts
const retained = await retainRegisteredRecoveryCheckpointImages({
  root,
  db,
  expected,
  localMaxBytes,
  sharedMaxBytes,
  assetMaxBytes,
  executionMaxBytes,
  actionMaxBytes,
  createValidationDatabase,
});
```

The combined saved manifest must cover all first-recorded inputs, including
earlier child arguments and skipped children. Keep these additional entries
when preparing the asset descriptor. Current execution inputs still require
their own per-set coverage. Checks verify the trusted original contents and
their exact execution, shared and local source bindings before reservation.

The result adds the original `actionBinding` beside `executionBinding` and
`assetCheckpoint`. All five original catalog bindings and saved files are
checked under the image writer lock before and after reservation and byte
verification. Changed originals or temporary evidence refuse success. New
reservations roll back after a failed recheck. Earlier pending or retained
protection survives failed loading, verification or commits.

The reservation commits before any image bytes are read. First-recorded and
skipped-child images remain protected through cleanup after earlier owners are
released. Matching archived images can be verified without reinstalling them.
Missing or changed required bytes leave the earlier protection intact.

The image owner and asset descriptor formats remain unchanged. Supply
`actionMaxBytes` and `executionMaxBytes` for every call that requires original
coverage. A retained owner does not record that coverage policy or serve as a
receipt for complete bundle publication.

## Check saved retained-run images

Save the matching [retained runs](shared-recovery-retained-payloads.md) and
[retained manifests](retained-recovery-asset-payloads.md), then supply both
`retainedMaxBytes` and `retainedAssetMaxBytes`. This path also requires
`assetMaxBytes`, `executionMaxBytes` and `actionMaxBytes`. All seven payload limits
must be positive safe integers. Host `history` manifests are refused with these
options.

```ts
const retained = await retainRegisteredRecoveryCheckpointImages({
  root,
  db,
  expected,
  localMaxBytes,
  sharedMaxBytes,
  executionMaxBytes,
  actionMaxBytes,
  assetMaxBytes,
  retainedMaxBytes,
  retainedAssetMaxBytes,
  createValidationDatabase,
});
```

Loading verifies the retained manifest and all six saved sources, including exact
SQL checks of local and selected rows and both endpoints of every retained run.
Each run's own manifests must cover its baseline, full effects and actual inputs.
Original and skipped inputs retain independent coverage, as do current selected
no-op invocations. The exact combined manifest includes current local images and
extra host requirements. Requirements from another run cannot fill a missing
per-record entry.

The result adds the original `retainedBinding` and `retainedAssetCheckpoint`
beside the current `assetCheckpoint`, `executionBinding` and `actionBinding`.
All seven catalog expectations and saved files are rechecked under the image
writer lock before and after reservation and physical image verification.
Changed bytes, temporary evidence and missing or changed bindings cause failure.
Failures preserve earlier pending or retained pins, including failed commits
and changes caused by owner publication itself.

The reservation commits before any image bytes are read. Images used only by
origin or superseded runs remain protected through cleanup after earlier staging
owners are released. Matching archived bytes can be verified without reinstalling
them. Competing catalog and owner writes serialize with verification.

The stable image owner format remains unchanged. An earlier reservation with a
smaller current-only manifest cannot be expanded under the same checkpoint key.
Prepare a new checkpoint identity for different requirements. This refusal
preserves the earlier pins. Supply the retained read limits on every call that
requires retained-run coverage. Owner state is not a durable receipt for that
coverage policy or complete bundle publication.

## Check saved broader run images

Save the matching [broader original-action archive](shared-recovery-action-archive-payloads.md),
[run archive](shared-recovery-run-archive-payloads.md) and
[run manifests](run-archive-asset-payloads.md). Add `actionArchiveMaxBytes`,
`runArchiveMaxBytes` and `runAssetMaxBytes` to the saved-manifest options. This
path also requires `assetMaxBytes`, `executionMaxBytes` and `actionMaxBytes`.
All eight payload limits must be positive safe integers. Host `history` and
selected-root `retainedMaxBytes` or `retainedAssetMaxBytes` cannot be combined
with broader run coverage. Missing limits cause failure before SQL allocation.

Reserve or verify broader requirements through the same image workflow.

```ts
const retained = await retainRegisteredRecoveryCheckpointImages({
  root,
  db,
  expected,
  localMaxBytes,
  sharedMaxBytes,
  executionMaxBytes,
  actionMaxBytes,
  assetMaxBytes,
  actionArchiveMaxBytes,
  runArchiveMaxBytes,
  runAssetMaxBytes,
  createValidationDatabase,
});
```

Loading verifies the broader manifest and all seven saved sources. SQL validation
checks exact source values and both endpoints of every archived run. Coverage
includes each run's baseline, full effects and actual root and child inputs.
First-recorded inputs retain separate coverage, including skipped children and
actions that never execute. Current per-set invocation coverage remains required.
The exact combined manifest includes local images, pending upload requirements
and host extras. Requirements from another run cannot fill a per-record gap.

The result adds the original `actionArchiveBinding`, `runArchiveBinding` and
`runAssetCheckpoint` beside `assetCheckpoint`, `executionBinding` and
`actionBinding`. All eight original catalog expectations and saved files are
rechecked under the image writer lock before and after reservation and byte
verification. Checks retain the exact original local descriptor on every source.
Changed contents, temporary evidence or missing bindings cause failure. New owner
publication rolls back if it changes a required binding. Earlier pending or
retained protection survives failed loading, verification and commits.

Pending protection commits before any image bytes are read. Images used only by
additional origin, rebase or authoritative runs, nested or skipped inputs, and
never-executed originals remain protected through cleanup after earlier owners
are released. Matching archived images can be verified without reinstalling
them. Catalog and owner writes serialize with byte verification.

The image owner format remains unchanged. A current-only or selected-root owner
cannot be expanded to a different manifest under the same checkpoint key. Keep
the earlier pins and prepare a new checkpoint identity for changed requirements.
Supply all broader read limits on every call requiring this coverage. Owner state
is not a durable receipt for a coverage policy or complete bundle publication.
[Recovery bundle indexes](recovery-bundle-indexes.md) bind the eight payload
references and their exact combined requirements before
[registered bundle publication](recovery-bundles.md).

## Supply host manifests

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
`changed` flag. The saved-manifest path also returns `assetCheckpoint` and adds
`executionBinding` when execution coverage is requested. Original coverage also
returns `actionBinding`. Retained-run coverage adds `retainedBinding` and
`retainedAssetCheckpoint`. It checks
the required catalog bindings and published files under the image writer lock
before and after owner publication. Missing or changed payload bytes and any
temporary evidence refuse reservation. This operation does not read image bytes.

The owner uses the same checkpoint key as the
[local payload image workflow](local-recovery-payloads.md#protect-checkpoint-images).
An existing owner can be reused only with the exact same manifest. Repeating a
reservation preserves its timestamps. Changed requirements cannot replace it,
and released owner IDs cannot be reused.

`retainRegisteredRecoveryCheckpointImages` first commits that reservation. A
separate writer transaction verifies every required live or archived image.
Archived bytes are accepted without reinstalling them. Required catalog bindings
and payload files are checked before and after image verification. Cleanup and
competing owner releases serialize with verification through the same lock.

Missing, unsafe or changed image bytes refuse success. Failed verification or
its final commit leaves the earlier pending protection intact. A failed recheck
of an already retained owner preserves its earlier record and protection.
Explicit retries verify image bytes again. Neither helper changes payload files,
installs images or releases earlier owners.

## Retain the checkpoint

Core [content-bound recovery image requirements](recovery-asset-checkpoints.md)
bind per-record requirements and the combined manifest to the exact local/shared
descriptor pair. The saved-manifest path carries that expectation through image
reservation and verification. An earlier host reservation can be reused only
when its combined manifest matches exactly. Changed requirements preserve the
earlier owner and refuse replacement.

Pending and retained recovery owners both protect their manifests during cleanup.
Release an owner only through an explicit ledger retirement decision after the
checkpoint is no longer needed. Earlier staging owners can be released after
the new reservation commits.

These operations protect image requirements for saved recovery payloads. Complete
action and execution retention, complete bundle publication and one-time
installation remain pending. A retained image owner
does not serve as a bundle publication or activation receipt.
