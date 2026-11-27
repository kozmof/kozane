# Saved recovery asset manifests

The Node host can save registered recovery manifests as immutable JSON files.
Use `saveRegisteredRecoveryAssetPayload`, `loadRegisteredRecoveryAssetPayload`
and `inspectRegisteredRecoveryAssetPayload` in
`lib/server/recovery-asset-payload.ts` after retaining a
[trusted asset descriptor](recovery-asset-checkpoints.md#retain-trusted-asset-descriptors).

## Save the original manifests

Save the matching [local snapshot](local-recovery-payloads.md) and
[shared row history](shared-recovery-payloads.md) first. Keep the original asset
payload returned by `describeRecoveryAssets`. Registration itself changes local
data, so later capture requires a new checkpoint identity.

Supply `root`, the trusted catalog `db`, the original payload as `input` and the
host's `expected` identity. Set `localMaxBytes` and `sharedMaxBytes` to positive
safe integers. A registered source length above its limit is refused before
opening files. The limits bound input bytes, while parsing and validation need
additional memory.

Supply `createValidationDatabase` with ownership of separate empty databases and
their disposal. The workflow validates the local and shared source payloads
sequentially. Each source undergoes its own content and exact SQL validation.
Asset payload bytes must match the trusted asset descriptor before source SQL
allocation. The combined manifest must then match the local requirements and
complete supplied history manifests, including intermediate and invocation-only
references.

Manifest files live under `.kozane/recovery/asset-manifests`. Published filenames
use the lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication uses the same file protocol as the source payloads. It creates a
temporary file exclusively with mode `0600`, writes canonical UTF-8 bytes and
syncs the file. After checking length, hash and file identity, it publishes
through an exclusive hard link, removes the temporary name and syncs the
directory. Directory sync is skipped on Windows. The file itself is always
synced.

The asset, shared and local catalog expectations remain committed before writes.
All three original bindings and both saved source files are rechecked under the
writer lock before and after publication. Missing or changed source bytes and
any source temporary evidence refuse success. Matching existing manifest bytes
are verified without rewriting them. Unsafe paths, different existing bytes and
any manifest temporary evidence require review.

The result contains `path`, the original asset `checkpoint` and a `changed` flag.
Failures preserve catalog intent and temporary or published evidence. A failed
outer commit can leave verified published bytes after the call rejects. An
explicit retry with the original payload can verify those bytes without
rewriting them. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredRecoveryAssetPayload(root, db, key)` reads the retained asset
expectation and observes its published and temporary files. It reports absent,
matching, different, unsafe or unreadable content. Reads use a fixed buffer and
at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence. It
can report an orphaned asset expectation after its source catalog records
disappear. This observation does not authorize saving or loading that checkpoint.

## Read saved manifests

Call `loadRegisteredRecoveryAssetPayload` with the save inputs except `input` and
add `maxBytes` for the asset payload. All three byte limits must be positive safe
integers. Registered lengths above their respective limits refuse loading before
file opens or content allocation.

The reader accepts only the published asset file. It verifies bounded raw bytes,
strict UTF-8 JSON and canonical content against the trusted descriptor before
source SQL allocation. Temporary entries, unsafe paths and malformed content
refuse loading. Both saved source payloads are then reopened and validated, and
asset coverage is recomputed against their exact contents.

Before returning, the reader checks all three original catalog bindings and both
source files under the writer lock. The asset file must retain its identity,
length and modification metadata, and its temporary path must remain absent.
The immutable result contains `payload` and its trusted `checkpoint`. Loading
performs no filesystem writes or live row installation. Temporary SQL rows are
rolled back in each validation database.

## Check saved execution coverage

Save the matching [execution payload](shared-recovery-execution-payloads.md) and
pass `executionMaxBytes` to either the save or load operation. This optional host
limit must be a positive safe integer. An execution descriptor above the limit,
a missing registration or mismatched original source bindings refuses work
before opening files. The workflow copies the option before awaiting validation.

```ts
const saved = await saveRegisteredRecoveryAssetPayload({
  root,
  db,
  expected,
  input: assets.payload,
  localMaxBytes,
  sharedMaxBytes,
  executionMaxBytes,
  createValidationDatabase,
});
```

The saved execution loader verifies trusted contents, both sources and execution
attribution. Each effect-set manifest must cover its root input and every child
input, including no-op children and zero-effect roots. An image listed only in
another set's manifest does not satisfy that check, even when the combined
manifest is unchanged. Extra supplied manifest entries remain required.

Both sources also undergo the asset loader's validation. Supply a separate empty
validation database and own its disposal for every factory call. Missing or
changed execution bytes and any execution temporary evidence refuse success.
All four original catalog bindings and the execution, shared and local source
files are rechecked around asset publication or before loading returns.

The result adds `executionBinding` with the original trusted execution descriptor
and local expectation. The asset format and its descriptor still bind the
shared/local pair. Execution coverage is an explicit check for each call.
Omitting `executionMaxBytes` leaves invocation coverage to the host's retained
records and manifests. Inspection observes asset evidence without checking
execution coverage.

## Check saved original actions

Save the matching [original-action payload](shared-recovery-action-payloads.md)
and pass `actionMaxBytes` with `executionMaxBytes` to either save or load.
The original-action limit must be a positive safe integer. A missing execution
limit is refused. Registered source lengths above their respective limits are
refused before file opens. Loading also requires the asset payload's `maxBytes`
limit.

Include images from every original input when preparing the history manifests
passed to `describeRecoveryAssets`. This includes first-recorded child inputs
that later change and children skipped by selected executions. Register the
complete asset descriptor before publication. Changed requirements cannot
replace an existing checkpoint under the same key.

```ts
const saved = await saveRegisteredRecoveryAssetPayload({
  root,
  db,
  expected,
  input: assets.payload,
  localMaxBytes,
  sharedMaxBytes,
  executionMaxBytes,
  actionMaxBytes,
  createValidationDatabase,
});
```

The workflow loads and verifies the registered original payload before checking
every first-recorded input against the combined asset manifest. Original records
are independent of later execution sets, so their image entries can appear in
any supplied history manifest. Current execution inputs still require coverage
in their own selected effect-set manifest. Supplying `actionMaxBytes` preserves
that check too. Extra supplied requirements remain required.

Original bytes, their execution and shared hashes, attribution and exact source
SQL values are checked through the composed loaders. These loaders can validate
the same source more than once. Own a separate empty database and its disposal
for every validation factory call. Missing or changed original bytes and any
original temporary evidence refuse success.

The result adds the original `actionBinding` beside `executionBinding`. All five
original catalog bindings and the four saved source files are rechecked around
asset publication or before loading returns. Failed publication or final commits
preserve temporary or published evidence for explicit review.

The asset descriptor format remains unchanged. Original coverage is an explicit
check for each call. Omitting `actionMaxBytes` leaves first-recorded input
coverage to the host. Inspection observes asset evidence without checking
original coverage.

## Continue bundle preparation

Saved manifests preserve requirements for both source payloads. These operations
do not read image bytes or create image reservations. Missing required images
can remain in a saved manifest. Keep earlier pins until a recovery image owner
has committed protection and verified its required bytes.

The [saved checkpoint image workflow](recovery-checkpoint-images.md#use-registered-saved-manifests)
accepts `assetMaxBytes` to load these manifests and commit their image protection
before byte verification. Supplying `executionMaxBytes` also checks saved
execution coverage and carries all four original catalog expectations and files
through the image writer boundary. Adding `actionMaxBytes` also checks original
inputs and carries all five original expectations and saved files through image
protection. Complete history retention, complete bundle publication, one-time
installation and activation remain pending. A saved manifest is not a bundle
publication or installation receipt.
