# Local image upload staging

Image uploads reserve their names before publishing files. Migration 0025 adds
`local_image_upload` as device-local metadata with no foreign keys to shared rows.
Each record retains its filename, byte length, SHA-256 hash and progress timestamps.

The Node host copies and validates incoming bytes before reserving a UUID filename.
It commits a pending record before creating directories or files. It then acquires
the database writer lock, writes and syncs a temporary file, and publishes it with
an exclusive hard link. Existing destination names are never overwritten.
Installation verifies the final file's identity, length and hash before marking
the record installed and returning its URL. Symlinked image directories are refused.

The file is synced before publication. Directory entries are synced where Node
supports directory fsync. Windows skips directory fsync. Filesystem callbacks run
once and are never retried automatically.

## Transfer protection to a card reference

The application card create and update adapters complete installed upload records
in the same transaction as the card write. CLI image creation uses the same
transaction-bound adapter. Completion preserves the recorded filename, length,
hash and installation evidence. A failed statement or commit rolls back both
the card change and staging completion, leaving the pin intact.

Completed records retain metadata while live card references protect the bytes.
Pending and installed records pin files even when no card refers to them. The
collector and queued deletion worker acquire the same writer lock before reading
references and pins and keep it through their filesystem work. They leave pinned
files and deletion requests alone. Lock contention may refuse a cleanup attempt.
Maintenance contains that failure and a later invocation can try again.

A failed prepared transaction start can leave an active statement in the local
libsql connection. The Node adapter reconnects that idle connection after a
transient start failure and restores required pragmas. It reports the original
failure without entering or retrying the application callback.

## Interrupted uploads

A filesystem failure preserves its pending record and attempts to retain the error.
Temporary files or published bytes remain available for review. If installation
finished but its confirmation failed, the pending record and verified file remain.
CLI card creation no longer deletes an uploaded file after a failed card write.

Unfinished pins have no automatic expiry. Explicit recovery and abandonment are
still pending, so an unused or interrupted upload may remain pinned. No startup
or maintenance path repeats its installation work or clears its evidence.

Shared capture, projection validation and restoration exclude upload records.
Version 15 recovery exports retain all states, including errors and abandoned
records. Older supported dumps import with an empty upload table when it is absent.
Imports validate filenames and metadata and never install files. Image bytes still
need a separate backup. Memory sessions keep their database ephemeral and skip
persistent image cleanup.

This staging does not yet protect production baselines, effect sets, transfers or
recovery bundles. Those owners need their own retained manifests and pins before
cleanup can account for them. Mandatory action capture remains disabled.
