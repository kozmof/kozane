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

Reservation verifies its exact generated fields after insertion triggers and
before commit. The installer rechecks that reservation before disk work. After
installation triggers finish, it verifies the final receipt, published bytes,
safe image directories and absence of a temporary file. Changed publication
retains the pending pin and current disk state without repeating installation.

The file is synced before publication. Directory entries are synced where Node
supports directory fsync. Windows skips directory fsync. Filesystem callbacks run
once and are never retried automatically.

## Transfer protection to a card reference

The application card create and update adapters complete installed upload records
in the same transaction as the card write. CLI image creation uses the same
transaction-bound adapter. Completion preserves the recorded filename, length,
hash and installation evidence. A failed statement or commit rolls back both
the card change and staging completion, leaving the pin intact.

Completion snapshots unfinished pins under the writer lock and verifies the
entire selected batch after database triggers finish. Each completed upload must
still have a card reference and other unfinished pins must stay unchanged. A newly
referenced installation introduced by a trigger also refuses completion. Failed
verification rolls back the card write and pin changes together.

Creation and installation timestamps retain their SQL storage class and value,
including integers outside JavaScript's safe range, exact REAL values, text and
blobs. Completion changes no timestamp values on unrelated pins.

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

Error recording matches the original pending intent and never overwrites an
existing error. It verifies its final receipt after database triggers finish.
Failed recording preserves the current pin and reports both failures. Separately
committed errors remain intact.

Unfinished pins have no automatic expiry. List them and preview recovery with
the full filename printed by `doctor` or authenticated startup.

```sh
kozane image uploads
kozane image recover <filename>
kozane image recover <filename> --apply
```

Recovery requires matching published bytes, an absent temporary file and no
recorded filesystem error. Unsafe paths, symlinks, unreadable or changed files
and unrepresentable timestamps block confirmation. Applying rechecks evidence
under the installer and cleanup writer lock. Contention may refuse a concurrent
command without entering its callback. Recovery never changes files or shared rows.

A pending record becomes installed after confirmation. If a card already refers
to that image, recovery completes only that upload's bookkeeping in the same
transaction. An unreferenced installation keeps its pin. Repeating confirmation
is idempotent. Historical completed records need no new filesystem work.
Abandoned uploads cannot be recovered. Create an image card from a verified URL
to complete its installed pin with the card transaction.

```sh
kozane card add "kozane-image:/api/images/<filename>"
```

Before committing recovery, the host rechecks published bytes, absence of a
temporary file and card-reference presence after database triggers finish. The
final receipt must match the intended state, filename, length, hash, timestamps
and retained evidence. A changed receipt or reference rolls back database changes
and preserves the earlier pin. Changed disk bytes, temporary files and symlinks
remain available for review without repeating installation.

Review blocked or unused uploads before abandoning their pin.

```sh
kozane image abandon <filename> --reason "Reviewed unused upload"
kozane image abandon <filename> --reason "Reviewed unused upload" --apply
```

The default is read-only. Applying preserves the filename, length, hash, error
and installation time and records a separate decision time and reason. Repeating
the same decision makes no changes. Another reason cannot replace it. Completed
records cannot be abandoned. Failed statements or commits retain the prior state
and pin. The shared writer lock prevents release during an active installation.

Abandonment verifies the final decision and retained metadata after database
triggers finish. Card-reference presence must still match the inspected state.
Changed intent, evidence, reason, decision time or references roll back the
decision and triggered database changes together. Files stay unchanged and the
earlier pin remains in place.

Abandonment changes no files or card references and does not run cleanup. Live
references still protect abandoned files. Normal maintenance can collect
unreferenced published files and abandoned regular temporary files after 24 hours.
A queued deletion may remove both after references and pins are gone. Untracked
temporary names are left alone. Evidence and decision records remain.

`image uploads --all` includes completed and abandoned records. Startup and
`doctor` report at most five unfinished filenames and their published and
temporary file observations. They never confirm, abandon or retry upload work.
`doctor --fix` also leaves upload records unchanged.

Shared capture, projection validation and restoration exclude upload records.
Version 15 recovery exports retain all states, including errors and abandoned
records. Older supported dumps import with an empty upload table when it is absent.
Imports validate filenames and metadata and never install files. Image bytes still
need a separate backup. Memory sessions keep their database ephemeral and skip
persistent image cleanup.

Upload staging does not infer history or transfer references. The separate
[manifest ledger](asset-manifest-retention.md) protects registered owners alongside
upload pins. Production workflows must register their manifests before relying
on that protection. Mandatory action capture remains disabled.
