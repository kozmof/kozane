# Saved recovery run archives

The Node host can save runs for roots outside the current materialization as
immutable JSON files. Use `saveRegisteredSharedRecoveryRunArchivePayload`,
`loadRegisteredSharedRecoveryRunArchivePayload` and
`inspectRegisteredSharedRecoveryRunArchivePayload` in
`lib/server/shared-recovery-run-archive-payload.ts` after registering a
[trusted run descriptor](shared-recovery-run-archives.md#retain-trusted-run-descriptors).

## Save archived runs

Save the matching [local snapshot](local-recovery-payloads.md),
[selected shared history](shared-recovery-payloads.md),
[selected executions](shared-recovery-execution-payloads.md),
[current originals](shared-recovery-action-payloads.md) and
[original-action archive](shared-recovery-action-archive-payloads.md) first.
Keep the original payload returned by `describeSharedRecoveryRunArchive`.
Registering catalogs changes local data, so a later local snapshot needs a new
checkpoint identity.

Supply `root`, the trusted catalog `db`, the run payload as `input` and the host's
complete `expected` identity. Set `localMaxBytes`, `sharedMaxBytes`,
`executionMaxBytes`, `actionMaxBytes` and `actionArchiveMaxBytes` to positive safe
integers. Registered source lengths above their limits cause failure before file
opens. These limits bound input bytes. Parsing and validation need additional
memory.

Supply `createValidationDatabase` with ownership of separate empty canonical
databases and their disposal. Source loaders may request several databases to
validate exact local and selected shared rows. Run validation also checks each
complete before and final after state in separate databases. When the current
checkpoint selects no runs, it also checks the current baseline. Each check rolls
temporary rows and trigger changes back before success.

Canonical run bytes must match the trusted descriptor before source SQL
allocation. Verification checks all saved source contents, the complete trusted
run inventory and exact current selected records. Additional origin, rebase and
authoritative runs keep their own independent contexts. Root inputs and complete
provider maps remain exact. Child inputs may differ between runs. Nested and
skipped executions, sequence metadata in the original archive, unknown kinds and
positive contract versions remain data. No handlers run.

Files live under `.kozane/recovery/run-archives`. Published filenames use the
lowercase SHA-256 digest followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint IDs never become path components.

Publication exclusively creates a temporary file with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It verifies length, hash and file
identity, publishes through an exclusive hard link, removes the temporary name
and syncs the directory. Directory sync is skipped on Windows. The file itself
is always synced.

All six catalog expectations must be committed before publication. The run,
original-action archive, current original, execution, shared and local bindings
and all five saved source files are rechecked under the writer lock before and
after publication. Missing or changed sources and any source temporary evidence
cause failure. Matching published run bytes are verified without rewriting them.
Unsafe paths, different existing bytes and any run temporary evidence require
review.

The result contains `path`, the original `binding` and `changed`. The binding
contains the run `checkpoint` and its original `localCheckpoint`. Failures
preserve catalog intent and file evidence. A failed outer commit can leave
verified published bytes after the call rejects. An explicit retry with the
original payload can verify matching final bytes when the temporary path is
absent. There is no automatic retry, replacement or cleanup.

## Inspect interrupted publication

`inspectRegisteredSharedRecoveryRunArchivePayload(root, db, key)` reads the run
binding and observes its published and temporary files. It reports absent,
matching, different, unsafe or unreadable content. Reads use a fixed buffer and
at most the registered length plus one byte.

Inspection creates no directories and never publishes or removes evidence.
Historical and orphaned expectations remain inspectable. Inspection does not
authorize saving or loading.

## Read saved runs

Call `loadRegisteredSharedRecoveryRunArchivePayload` with the save inputs except
`input` and add `maxBytes` for the run archive itself. All six limits must be
positive safe integers. Registered lengths above their limits refuse loading
before file opens or content allocation.

The reader accepts only the published run file. It checks bounded raw bytes,
strict UTF-8 JSON and canonical contents against the trusted descriptor before
source SQL allocation. Temporary entries, unsafe paths and malformed contents
cause failure. Source loaders verify all five saved payloads and validate exact
local and current shared SQL values. Each archived run's endpoints are then
validated.

Before returning, the reader rechecks all six original catalog bindings and all
five saved source files under the writer lock. The run file must preserve its
identity, length and modification metadata. Its temporary path must remain
absent. Rewritten, replaced or removed files cause failure, including rewrites
with matching bytes. The immutable result contains `payload` and the original
`binding`. Loading performs no filesystem writes or live row installation.

## Continue bundle preparation

Saved run archives preserve broader execution and effect records.
[Run archive asset checkpoints](run-archive-asset-checkpoints.md) prepare
content-bound manifests for these runs and all archived original inputs. Durable
manifest storage, image protection, complete bundle publication and installation
remain pending. These helpers do not select
additional runs or invoke handlers. Startup does not automatically repeat
filesystem work.
