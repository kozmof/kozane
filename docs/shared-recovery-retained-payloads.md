# Saved retained recovery history

The Node host can save origin, superseded rebase and authoritative runs as
immutable JSON files. Use `saveRegisteredSharedRecoveryRetainedPayload`,
`loadRegisteredSharedRecoveryRetainedPayload` and
`inspectRegisteredSharedRecoveryRetainedPayload` in
`lib/server/shared-recovery-retained-payload.ts` after retaining a
[trusted retained-history descriptor](shared-recovery-retained-history.md#retain-trusted-descriptors).

## Save retained runs

Save the matching [local snapshot](local-recovery-payloads.md),
[selected shared history](shared-recovery-payloads.md),
[selected executions](shared-recovery-execution-payloads.md) and
[original actions](shared-recovery-action-payloads.md) first. Keep the original
payload returned by `describeSharedRecoveryRetainedHistory`. A later local
snapshot needs a new checkpoint identity because registration changes local data.

Supply `root`, the trusted catalog `db`, the retained payload as `input` and the
host's complete `expected` identity. Set `localMaxBytes`, `sharedMaxBytes`,
`executionMaxBytes` and `actionMaxBytes` to positive safe integers. Registered
source lengths above their respective limits cause failure before file opens.
These limits bound input bytes. Parsing and validation require additional memory.

Supply `createValidationDatabase` with ownership of separate empty canonical
databases and their disposal. The source loaders can call it several times to
validate exact local and selected shared rows. Retained-history validation also
checks each run's complete before and final after state in separate databases.
A baseline-only archive validates its current baseline once. Every validation
rolls back temporary rows and trigger changes before success.

Retained bytes must match the trusted descriptor before source SQL allocation.
Verification then checks all saved source hashes, immutable root inputs and
provider maps, original action identities and selected run contents. Every run
keeps its full before images, context and actual execution inputs. Origin and
superseded runs remain independent of the selected materialization. Unknown
action kinds and positive contract versions remain data. No handlers run.

Files live under `.kozane/recovery/retained-history`. Published filenames use
the lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication creates a temporary file exclusively with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It verifies length, hash and file
identity, publishes through an exclusive hard link, removes the temporary name
and syncs the directory. Directory sync is skipped on Windows. The file itself
is always synced.

All five catalog expectations must be committed before publication. The retained,
original-action, execution, shared and local bindings and all four saved source
files are rechecked under the writer lock before and after publication. Missing
or changed sources and any source temporary evidence cause failure. Matching
existing retained bytes are verified without rewriting them. Unsafe paths,
different existing bytes and any retained temporary evidence require review.

The result contains `path`, the original `binding` and `changed`. The binding's
`checkpoint` is the retained descriptor and `localCheckpoint` is its original
local expectation. Failures preserve catalog intent and file evidence. A failed
outer commit can leave verified published bytes after the call rejects. An
explicit retry with the original payload can verify matching final bytes when
the temporary path is absent. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredSharedRecoveryRetainedPayload(root, db, key)` reads the
retained binding and observes its published and temporary files. It reports
absent, matching, different, unsafe or unreadable content. Reads use a fixed
buffer and at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence.
Historical and orphaned expectations remain inspectable. That observation does
not authorize saving or loading a payload.

## Read saved history

Call `loadRegisteredSharedRecoveryRetainedPayload` with the save inputs except
`input` and add `maxBytes` for the retained payload. All five limits must be
positive safe integers. Registered lengths above their respective limits refuse
loading before file opens or content allocation.

The reader accepts only the published retained file. It checks bounded raw bytes,
strict UTF-8 JSON and canonical contents against the trusted descriptor before
source SQL allocation. Temporary entries, unsafe paths and malformed contents
cause failure. Saved originals, selected executions and shared rows are then
loaded with their original local source and undergo content, attribution and
exact SQL validation. Both endpoints of each retained run also undergo isolated
SQL checks.

Before returning, the reader rechecks all five original catalog bindings and all
four source files under the writer lock. The retained file must preserve its
identity, length and modification metadata. Its temporary path must remain
absent. Rewritten, replaced or removed files cause failure, including rewrites
with matching bytes. The immutable result contains `payload` and the original
`binding`. Loading performs no filesystem writes or live row installation.

## Continue bundle preparation

These files preserve runs for roots in the current selected checkpoint. Roots
outside that checkpoint, retained manifest storage and complete bundle
publication remain pending.

Saving and loading retained history do not read images or reserve them. Use
`sharedRecoveryRetainedAssetManifest` to collect per-run metadata requirements,
including deselected rows and execution inputs. Original invocation and current
shared/local requirements remain separate inputs to the combined manifest.
Connecting saved retained files to protected image verification remains pending.
Installation and activation remain pending. Startup does not automatically
repeat filesystem work.
