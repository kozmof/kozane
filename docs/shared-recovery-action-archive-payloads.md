# Saved recovery action archives

The Node host can save original actions for roots outside the current
materialization as immutable JSON files. Use
`saveRegisteredSharedRecoveryActionArchivePayload`,
`loadRegisteredSharedRecoveryActionArchivePayload` and
`inspectRegisteredSharedRecoveryActionArchivePayload` in
`lib/server/shared-recovery-action-archive-payload.ts` after registering a
[trusted archive descriptor](shared-recovery-action-archives.md#retain-trusted-archive-descriptors).

## Save an archive

Save the matching [local snapshot](local-recovery-payloads.md),
[selected shared history](shared-recovery-payloads.md),
[selected executions](shared-recovery-execution-payloads.md) and
[current originals](shared-recovery-action-payloads.md) first. Keep the original
payload returned by `describeSharedRecoveryActionArchive`. Registering catalogs
changes local data, so capturing a later local snapshot needs a new checkpoint
identity.

Supply `root`, the trusted catalog `db`, the archive payload as `input` and the
host's full `expected` identity. Set `localMaxBytes`, `sharedMaxBytes`,
`executionMaxBytes` and `actionMaxBytes` to positive safe integers. Registered
source lengths above their limits cause failure before file opens. These limits
bound input bytes. Parsing and validation require additional memory.

Supply `createValidationDatabase` with ownership of separate empty canonical
databases and their disposal. The source loaders may call it several times to
validate exact local and selected shared rows. Each check rolls back temporary
rows and trigger changes. Additional archive roots contain original records and
do not add SQL states to validate.

Canonical archive bytes must match the trusted descriptor before source SQL
allocation. Verification checks all saved source contents, the complete trusted
root and action inventories, first-record relations and exact current originals.
Nested and skipped actions, original inputs, provider maps, sequence strings and
provenance remain exact. Unknown kinds and positive contract versions remain
data. A checkpoint without selected actions may retain additional roots.

Files live under `.kozane/recovery/action-archives`. Published names use the
lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication exclusively creates a temporary file with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It checks length, hash and file identity,
publishes through an exclusive hard link, removes the temporary name and syncs
the directory. Directory sync is skipped on Windows. The file itself is always
synced.

All five catalog expectations must be committed before publication. The archive,
original-action, execution, shared and local bindings and all four saved source
files are rechecked under the writer lock before and after publication. Missing
or changed sources and any source temporary evidence cause failure. Matching
published archive bytes are verified without rewriting them. Unsafe paths,
different existing bytes and any archive temporary evidence require review.

The result contains `path`, the original `binding` and `changed`. The binding
contains the archive `checkpoint` and its original `localCheckpoint`. Failures
preserve catalog intent and file evidence. A failed outer commit may leave
verified published bytes after the call rejects. An explicit retry with the
original payload may verify matching final bytes when the temporary path is
absent. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredSharedRecoveryActionArchivePayload(root, db, key)` reads the
archive binding and observes published and temporary files. It reports absent,
matching, different, unsafe or unreadable content. Reads use a fixed buffer and
at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence.
Historical and orphaned expectations remain inspectable. Inspection does not
authorize saving or loading.

## Read a saved archive

Call `loadRegisteredSharedRecoveryActionArchivePayload` with the save inputs
except `input` and add `maxBytes` for the archive itself. All five limits must be
positive safe integers. Registered lengths above their limits refuse loading
before file opens or content allocation.

The reader accepts only the published archive file. It checks bounded raw bytes,
strict UTF-8 JSON and canonical contents against the trusted descriptor before
source SQL allocation. Temporary entries, unsafe paths and malformed contents
cause failure. All four saved sources undergo content and exact SQL validation
before archive verification.

Before returning, the reader rechecks all five original catalog bindings and all
four saved source files under the writer lock. The archive file must preserve
its identity, length and modification metadata. Its temporary path must remain
absent. Rewritten, replaced or removed files cause failure, including rewrites
with matching bytes. The immutable result contains `payload` and the original
`binding`. Loading performs no filesystem writes or live row installation.

## Continue bundle preparation

Saved archives preserve broader original-action records. Execution and effect
retention for additional roots, their image protection, complete bundle
publication and installation remain pending. These helpers do not select runs
or invoke handlers. Startup does not automatically repeat filesystem work.
