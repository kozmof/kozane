# Saved original recovery actions

The Node host can save registered original-action payloads as immutable JSON
files. Use `saveRegisteredSharedRecoveryActionPayload`,
`loadRegisteredSharedRecoveryActionPayload` and
`inspectRegisteredSharedRecoveryActionPayload` in
`lib/server/shared-recovery-action-payload.ts` after retaining a
[trusted action descriptor](shared-recovery-actions.md#retain-trusted-action-descriptors).

## Save the original records

Save the matching [local snapshot](local-recovery-payloads.md),
[shared row history](shared-recovery-payloads.md) and
[selected executions](shared-recovery-execution-payloads.md) first. Keep the
original payload returned by `describeSharedRecoveryActions`. Registration
changes local data, so later snapshot capture requires a new checkpoint identity.

Supply `root`, the trusted catalog `db`, the original payload as `input` and the
host's full `expected` identity. Set `localMaxBytes`, `sharedMaxBytes` and
`executionMaxBytes` to positive safe integers. A registered source length above
its limit is refused before opening files. These limits bound input bytes.
Parsing and validation require additional memory.

Supply `createValidationDatabase` with ownership of separate empty databases and
their disposal. The composed source loaders can call this factory several times.
The execution loader validates both saved local and shared sources in isolation.
The shared payload is also reopened and validated for original-action
verification. Each SQL validation compares exact tagged values and rolls back
temporary rows before success.

Original-action bytes must match the trusted descriptor before source SQL
allocation. Verification then checks the original execution and shared content
hashes, original root inputs and complete provider maps. First-recorded child
inputs remain distinct from later resolved inputs. Skipped children, exact local
sequence strings and recorded provenance remain present. Unknown kinds and
positive contract versions remain data. No handlers run during validation.

Files live under `.kozane/recovery/actions`. Published filenames use the
lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication creates a temporary file exclusively with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It verifies length, hash and file
identity, publishes through an exclusive hard link, removes the temporary name
and syncs the directory. Directory sync is skipped on Windows. The file itself
is always synced.

All four catalog expectations must be committed before publication. The
original action, execution, shared and local bindings and all three saved source
files are rechecked under the writer lock before and after publication. Missing
or changed source bytes and any source temporary evidence refuse success.
Matching existing action bytes are verified without rewriting them. Unsafe
paths, different existing bytes and any action temporary evidence require review.

The result contains `path`, the original `binding` and `changed`. The binding's
`checkpoint` is the action descriptor and `localCheckpoint` is its original
local expectation. Failures preserve catalog intent and file evidence. A failed
outer commit can leave verified published bytes after the call rejects. An
explicit retry with the original payload can verify matching final bytes when
the temporary path is absent. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredSharedRecoveryActionPayload(root, db, key)` reads the retained
action binding and observes its published and temporary files. It reports
absent, matching, different, unsafe or unreadable content. Reads use a fixed
buffer and at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence. It
can report an orphaned action expectation after its source catalogs disappear.
That observation does not authorize saving or loading the checkpoint.

## Read saved originals

Call `loadRegisteredSharedRecoveryActionPayload` with the save inputs except
`input` and add `maxBytes` for the original-action payload. All four byte limits
must be positive safe integers. Registered lengths above their respective
limits refuse loading before file opens or content allocation.

The reader accepts only the published action file. It checks bounded raw bytes,
strict UTF-8 JSON and canonical content against the trusted descriptor before
source SQL allocation. Temporary entries, unsafe paths and malformed content
refuse loading. Saved execution and shared payloads are then loaded with their
original local source and undergo content, attribution and isolated SQL checks.

Before returning, the reader rechecks all four original catalog bindings and
all three source files under the writer lock. The action file must retain its
identity, length and modification metadata, and its temporary path must remain
absent. Rewritten, replaced or removed action files refuse success, including
rewrites with matching bytes. The immutable result contains `payload` and the
original `binding`. Loading performs no filesystem writes or live row installation.

## Continue bundle preparation

These files preserve first-recorded actions for the selected roots. They do not
retain origin or deselected effect sets. Complete history retention and complete
bundle publication remain pending.

Saving or loading originals does not read images or create image reservations.
Original inputs can reference images absent from selected executions and shared
rows. Saved manifest integration must still protect those additional
requirements. Retain their manifests and earlier image pins separately until
that workflow commits protection. Installation and activation remain pending.
Startup does not automatically repeat file work.
