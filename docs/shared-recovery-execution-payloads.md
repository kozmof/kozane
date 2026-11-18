# Saved shared recovery executions

The Node host can save registered execution payloads as immutable JSON files.
Use `saveRegisteredSharedRecoveryExecutionPayload`,
`loadRegisteredSharedRecoveryExecutionPayload` and
`inspectRegisteredSharedRecoveryExecutionPayload` in
`lib/server/shared-recovery-execution-payload.ts` after retaining a
[trusted execution descriptor](shared-recovery-executions.md#retain-trusted-execution-descriptors).

## Save selected execution records

Save the matching [local snapshot](local-recovery-payloads.md) and
[shared row history](shared-recovery-payloads.md) first. Keep the original payload
returned by `describeSharedRecoveryExecutions`. Registration changes local data,
so later snapshot capture requires a new checkpoint identity.

Supply `root`, the trusted catalog `db`, the original payload as `input` and the
host's `expected` identity. Set `localMaxBytes` and `sharedMaxBytes` to positive
safe integers. Registered source lengths above their limits are refused before
opening files. These limits bound input bytes. Parsing and validation require
additional memory.

Supply `createValidationDatabase` with ownership of separate empty databases and
their disposal. Execution bytes must match the trusted descriptor before source
SQL allocation. The workflow then loads both saved source payloads sequentially
and validates their exact SQL values in isolation. Execution verification checks
the original shared checkpoint, trusted roots and counts, complete bindings,
no-op children and row-effect attribution. Unknown action kinds and positive
contract versions remain data. No handlers run during validation.

Execution files live under `.kozane/recovery/executions`. Published filenames use
the lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication creates a temporary file exclusively with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It checks length, hash and file identity,
publishes through an exclusive hard link, removes the temporary name and syncs
the directory. Directory sync is skipped on Windows. The file itself is always
synced.

The execution, shared and local catalog expectations must be committed before
publication. All three original bindings and both saved source files are
rechecked under the writer lock before and after publication. Changed or missing
source bytes and any source temporary evidence refuse success. Matching existing
execution bytes are verified without rewriting them. Unsafe paths, different
existing bytes and any execution temporary evidence require review.

The result contains `path`, the original `binding` and `changed`. The binding's
`checkpoint` is the execution descriptor and `localCheckpoint` is its original
local expectation. Failures preserve catalog intent and file evidence. A failed
outer commit can leave verified published bytes after the call rejects. An
explicit retry with the original payload can verify those bytes without
rewriting them. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredSharedRecoveryExecutionPayload(root, db, key)` reads the
retained execution binding and observes the published and temporary files. It
reports absent, matching, different, unsafe or unreadable content. Reads use a
fixed buffer and at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence. It
can report orphaned execution metadata after either source catalog disappears.
That observation does not authorize saving or loading the checkpoint.

## Read saved execution records

Call `loadRegisteredSharedRecoveryExecutionPayload` with the save inputs except
`input` and add `maxBytes` for the execution payload. All three byte limits must
be positive safe integers. Registered lengths above their respective limits
refuse loading before file opens or content allocation.

The reader accepts only the published execution file. It checks bounded raw
bytes, strict UTF-8 JSON and canonical content against the trusted descriptor
before source SQL allocation. Temporary entries, unsafe paths and malformed
content refuse loading. Both saved source payloads then undergo content and
isolated SQL validation. Attribution is checked against the original shared
history.

Before returning, the reader rechecks all three original catalog bindings and
both source files under the writer lock. The execution file must retain its
identity, length and modification metadata, and its temporary path must remain
absent. Rewritten, replaced or removed execution files refuse success, including
rewrites with matching bytes. The immutable result contains `payload` and the
original `binding`. Temporary SQL rows are rolled back. Loading performs no
filesystem writes or live row installation.

## Continue bundle preparation

These files retain selected finalized scope data. The Node host can also retain
[original action payloads](shared-recovery-action-payloads.md) with first-recorded
inputs and provenance. Supplying `actionMaxBytes` with `executionMaxBytes` connects
original inputs to saved manifest checks and image protection. Origin and
deselected execution sets and retention policy remain requirements for complete history.

Saving or loading execution files does not read images or create image
reservations. Supply `executionMaxBytes` to the
[saved asset workflow](recovery-asset-payloads.md#check-saved-execution-coverage)
to check each set's invocation image coverage against these trusted records.
The [saved checkpoint image workflow](recovery-checkpoint-images.md#check-saved-execution-images)
carries the execution expectation and file through reservation and byte
verification with the other three payloads. Complete bundle publication,
one-time installation and activation remain pending. Startup does not
automatically repeat file work.
