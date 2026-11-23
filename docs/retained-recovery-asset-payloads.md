# Saved retained recovery manifests

The Node host can save registered retained manifests as immutable JSON files.
Use `saveRegisteredRetainedRecoveryAssetPayload`,
`loadRegisteredRetainedRecoveryAssetPayload` and
`inspectRegisteredRetainedRecoveryAssetPayload` in
`lib/server/retained-recovery-asset-payload.ts` after retaining a
[trusted retained-manifest descriptor](retained-recovery-asset-checkpoints.md#retain-trusted-descriptors).

## Save the manifests

Save the matching [local snapshot](local-recovery-payloads.md),
[selected shared history](shared-recovery-payloads.md),
[selected executions](shared-recovery-execution-payloads.md),
[original actions](shared-recovery-action-payloads.md),
[retained runs](shared-recovery-retained-payloads.md) and
[current asset manifests](recovery-asset-payloads.md) first. Keep the payload from
`describeRetainedRecoveryAssets`. A later local snapshot needs a new checkpoint
identity because registration changes local data.

Supply `root`, the trusted catalog `db`, the original retained-manifest payload
as `input` and the host's full `expected` identity. Set `localMaxBytes`,
`sharedMaxBytes`, `executionMaxBytes`, `actionMaxBytes`, `retainedMaxBytes` and
`assetMaxBytes` to positive safe integers. They bound the six saved source
payloads independently. Registered lengths above their limits cause failure
before opening files. Parsing and validation require additional memory.

Supply `createValidationDatabase` with ownership of separate empty canonical
databases and their disposal. The source loaders can call this factory several
times. They verify exact local and selected shared rows and both endpoints of
every retained run. Each SQL validation rolls back temporary rows and trigger
changes before success.

All seven catalog expectations must match before file reads. Retained-manifest
bytes must match the trusted descriptor before source SQL allocation. The source
loaders then reopen all six published payloads, validate their contents and
original bindings, and check exact SQL values. The retained manifest also
undergoes source hash and independent coverage verification.

Coverage includes each run's complete before-state, full before and after
effects, actual execution inputs, original and skipped inputs, selected no-op
invocations and current local requirements. Extra host requirements remain in
the exact combined manifest. Original-only requirements live in `originalImages`
and need not appear in the current asset payload's manifest.

Files live under `.kozane/recovery/retained-asset-manifests`. Published filenames
use the lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication creates a temporary file exclusively with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It verifies length, hash and file
identity, publishes through an exclusive hard link, removes the temporary name
and syncs the directory. Directory sync is skipped on Windows. The file itself
is always synced.

The retained-manifest, retained-history, current asset, original-action,
execution, shared and local bindings are rechecked under the writer lock before
and after publication. All six saved source files must match their original
descriptors and have no temporary evidence. Matching existing manifest bytes are
verified without rewriting them. Unsafe paths, different existing bytes and any
manifest temporary evidence require review.

The result contains `path`, the original `checkpoint` and `changed`. Failures
preserve catalog intent and file evidence. A failed outer commit can leave
verified published bytes after the call rejects. An explicit retry with the
original payload can verify matching final bytes if the temporary path is absent
and all sources still match. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredRetainedRecoveryAssetPayload(root, db, key)` reads the trusted
descriptor and observes its published and temporary paths. It reports absent,
matching, different, unsafe or unreadable content. Reads use a fixed buffer and
at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence.
Historical and orphaned expectations remain inspectable after their source
catalogs disappear. That observation does not authorize saving or loading.

## Read saved manifests

Call `loadRegisteredRetainedRecoveryAssetPayload` with the save inputs except
`input` and add `maxBytes` for the retained-manifest payload. All seven limits
must be positive safe integers. Registered lengths above their respective limits
refuse loading before file opens or content allocation.

The reader accepts only the published manifest file. It checks bounded raw
bytes, strict UTF-8 JSON and canonical contents against the trusted descriptor
before source SQL allocation. Temporary entries, unsafe paths and malformed
contents cause failure. All six saved sources then undergo content, attribution,
manifest coverage and isolated SQL checks. No handlers run or live rows install.

Before returning, the reader rechecks all seven exact original catalog bindings
and all six source files under the writer lock. The retained-manifest file must
preserve its identity, length and modification metadata. Its temporary path must
remain absent. Rewritten, replaced or removed files cause failure, including
rewrites with matching bytes. The immutable result contains `payload` and the
original `checkpoint`. Loading performs no filesystem writes.

## Continue bundle preparation

These files retain metadata for roots in the selected recovery checkpoint.
Saving and loading do not read image bytes or reserve images. Use the
[retained image workflow](recovery-checkpoint-images.md#check-saved-retained-run-images)
to reserve and verify their requirements against all seven original expectations.
Use [saved run archive manifests](run-archive-asset-payloads.md) for additional
roots. Complete bundle publication, installation and activation remain pending.
Startup does not automatically repeat filesystem work.
