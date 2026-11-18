# Saved shared recovery payloads

The Node host can save registered shared row history as an immutable JSON file.
`saveRegisteredSharedRecoveryPayload` and `loadRegisteredSharedRecoveryPayload`
in `lib/server/shared-recovery-payload.ts` connect disk storage to the
[trusted shared descriptor catalog](shared-recovery-projections.md#retain-trusted-shared-descriptors).

## Save the original payload

Register the local snapshot descriptor first, then the matching shared-history
descriptor. Keep the original shared payload returned by
`describeSharedRecoveryHistory`. Supply `root`, the trusted catalog `db`, that
payload as `input`, the host's `expected` checkpoint identity and a separate
`createValidationDatabase` factory.

Saving verifies both catalog bindings, the shared digest and exact SQL values
before creating payload directories. The writer transaction then rechecks the
original shared and local expectations. A different pair cannot replace the one
read before validation, even if the replacement pair is internally consistent.

Files live under `.kozane/recovery/shared-history`. Published filenames use the
lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components. Local
snapshot files remain under `.kozane/recovery/checkpoints`.

The shared file protocol creates a temporary file exclusively with mode `0600`,
writes canonical UTF-8 bytes and syncs the file. It verifies length, digest and
file identity, publishes through an exclusive hard link, removes the temporary
name and syncs the directory. Directory sync is skipped on Windows. The file
itself is always synced.

Existing matching published bytes are verified without rewriting them. Different
bytes, non-regular entries, symbolic links and unsafe parents refuse publication.
Any temporary evidence requires review, including a complete matching file.
There is no automatic retry, replacement or cleanup. Both catalog expectations
remain committed before payload writes, and participating catalog changes
serialize with publication through the writer lock.

The result reports the path, the original descriptor `binding` and whether this
call published new bytes. Failures preserve temporary and published evidence.
A failed outer commit can leave verified published bytes after the call rejects.
An explicit retry with the original payload can verify those bytes without
rewriting them.

## Inspect interrupted publication

`inspectRegisteredSharedRecoveryPayload(root, db, key)` reads the stored pair and
observes published and temporary files. It reports absent, matching, different,
unsafe or unreadable content. Verification uses a fixed buffer and reads at most
the registered length plus one byte. File identity and modification metadata
must stay stable during a matching read.

Inspection creates no directories, changes no catalog records and never removes
or publishes evidence. It can inspect a retained shared binding after its live
local descriptor disappears. That observation provides no permission to save or
load the orphaned checkpoint.

## Read a saved payload

Call `loadRegisteredSharedRecoveryPayload` with `root`, `db`, `expected`,
`maxBytes` and `createValidationDatabase`. The byte limit must be a positive safe
integer. A registered length above it is refused before opening the file or
allocating its content buffer. Parsing and reconstruction require additional
memory beyond the input bytes.

The reader accepts only the published file. Any temporary entry requires review.
It checks both catalog bindings under the writer lock, reads bounded bytes and
verifies the raw hash and file identity. Strict UTF-8 decoding and canonical
history verification precede isolated SQL validation. Canonical verification and
SQL validation run outside the source writer boundaries, allowing unrelated
checkpoint registrations.

Before returning, the reader rechecks the original catalog pair, its live local
binding and the published file's identity, size and modification metadata.
Changed, rewritten, replaced or removed files and new temporary entries refuse
success. The immutable result contains the canonical `payload`, reconstructed
`projection` and original `binding`. Temporary SQL rows are rolled back. Loading
performs no filesystem changes or live row installation.

## Current scope

The [saved checkpoint image workflow](recovery-checkpoint-images.md) validates
both saved payloads and checks shared row-image coverage before reserving their
combined image requirements. It commits protection before byte verification and
rechecks both saved files and catalog bindings under the image writer lock.

These files retain the baseline and selected row-effect reconstruction data.
The Node host can also retain [saved asset manifests](recovery-asset-payloads.md)
bound to both source payloads. Their image workflow can reserve those saved
requirements and verify protected bytes. It can also retain
[selected execution payloads](shared-recovery-execution-payloads.md) with trusted
roots, counts and row-effect attribution. Supplying `executionMaxBytes` connects
these records to saved manifest coverage and protected image verification.
Complete action and execution records and retention policies remain pending.
A complete bundle also needs the matching local payload and a durable publication
boundary.
Installation and activation remain pending. Startup does not repeat file work.
