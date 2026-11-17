# Local manifest retention

The local manifest ledger protects images for registered owners. Migration 0026
adds `local_asset_manifest` with separate baseline, effect-set, pending-work,
transfer and recovery owners. Owners have opaque IDs assigned by their workflow.
The ledger does not establish workspace or epoch identity or create action logs.

Each owner keeps an immutable version 1 manifest, a state and progress timestamps.
The public core parser and merge helpers validate canonical names, lengths and
SHA-256 hashes. Reservations also check all upload and manifest identity records.
Released owners and completed or abandoned uploads still prevent different bytes
from using the same image name. An owner ID cannot be reused after release.

## Reserve before reading or installing files

`reserveAssetManifest` in `db/api/asset-manifest.ts` commits a pending owner under
the image writer lock. Pending and retained owners both pin every manifest entry.
Reserve known metadata before transferring or verifying bytes, so cleanup cannot
remove a file while a workflow prepares its dependent record. Repeating the same
reservation is idempotent. Missing files do not remove the reservation.

The reservation API does not download, install or inspect files. Callers that
assemble metadata from existing local files must keep writer-lock protection or
another pin until reservation commits. Transfers must keep network work outside
database transactions.

`retainImageManifest` verifies protected local bytes under the writer lock and
marks the owner retained. It accepts live files or the readable image archive.
Unsafe paths, symlinks, missing files and changed bytes refuse verification while
preserving the pending pin. A corrupt live file cannot be hidden by a valid archive
copy. Verification does not move archived files back or change file contents.

Use `retainImageManifestInTx` when a dependent database record must commit with
verification. The caller owns that transaction. Failure rolls back publication
and verification together, preserving the earlier reservation. The database-only
`confirmVerifiedAssetManifestInTx` helper is trusted host bookkeeping and requires
prior verification of protected bytes in that same transaction.

## Release only the owner's protection

`releaseAssetManifest` records an explicit reason and release time without changing
files, the original manifest or prior verification time. Repeating the same
decision is idempotent. Another reason cannot replace it. Owners do not expire
automatically. Release and verification use the same writer lock as installation
and cleanup.

Cleanup combines live card references, unfinished upload pins and all pending or
retained manifest owners. Releasing one owner leaves other owners' protection
intact. Upload abandonment also leaves manifest protection intact, including
protection of matching temporary filenames. Queued deletion remains pending
until every applicable protection is gone. Malformed active manifests refuse
cleanup before filesystem changes.

Workflow transitions can reserve a new owner and release an old one in the same
transaction through the `InTx` helpers. A failed transaction preserves the old
owner and removes the uncommitted new reservation. These APIs do not run cleanup.

## Recovery and current scope

The ledger has no foreign keys to shared data. Shared capture, projection
validation and replacement exclude it and preserve pending, retained and released
owners. Version 17 JSON exports include all owners and decisions, plus checkpoint
descriptor records. Earlier
supported dumps import with an empty ledger when it is absent. Import validates
manifest paths and identity consistency without installing or verifying files.
Image bytes still require a separate backup.

Native and WASM tests cover reservation, release, collision checks, migration
rollback and shared restoration. Node tests cover archived verification,
publication failure, cross-connection locking and cleanup after the final live
reference disappears.

The capture prototype now uses these APIs through an optional host publication
hook. Tests commit baseline and effect-set owners with captured history, verify
actual files before releasing staging protection and preserve that protection
after failed publication. They also verify application upload completion in the
same action transaction. Cleanup contention cannot remove files during handoff.
Restoring an earlier selection leaves owners for deselected origin history intact.

The [local checkpoint asset helper](local-recovery-snapshots.md#collect-and-protect-checkpoint-images)
collects requirements from active snapshot records and selected shared-history
manifests. Tests reserve the result under a recovery owner before releasing
earlier pins. Missing required bytes preserve the pending recovery reservation
and prevent successful verification. Complete bundle publication remains pending.

This is a retention mechanism for trusted host workflows. Production action
history, transfer queues and recovery-bundle builders still need to register
their owners and release them under their retention policies. No new end-user
manifest commands are added, and mandatory action capture remains disabled.
