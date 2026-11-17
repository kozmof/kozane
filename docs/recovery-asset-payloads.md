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

## Continue bundle preparation

Saved manifests preserve requirements for both source payloads. These operations
do not read image bytes or create image reservations. Missing required images
can remain in a saved manifest. Keep earlier pins until a recovery image owner
has committed protection and verified its required bytes.

The [saved checkpoint image workflow](recovery-checkpoint-images.md) still accepts
host manifests directly. Connecting it to these saved asset payloads remains
pending. Complete action and execution retention, complete bundle publication,
one-time installation and activation also remain pending. A saved manifest is
not a bundle publication or installation receipt.
