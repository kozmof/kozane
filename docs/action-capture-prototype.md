# Action capture prototype

The prototype tests persistent row capture and exact installation on libsql and
SQLite WASM. Production stamping remains disabled. The browser check must pass
before the production log schema is finalized.

## Run the checks

Run the Node libsql prototype with the source test configuration.

```sh
pnpm exec vitest run --config vitest.source.config.ts \
  packages/kozane/src/db/api/action-capture*.test.ts \
  packages/kozane/src/db/api/action-restoration*.test.ts \
  packages/kozane/src/db/api/action-epochs.test.ts \
  packages/kozane/src/lib/server/action-epoch-restart.test.ts \
  packages/kozane/src/services/action-projection.test.ts \
  packages/kozane/src/services/action-restoration-plan.test.ts
```

Run the same capture tests against SQLite WASM in Node.

```sh
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts \
  packages/kozane/src/db/api/action-capture*.test.ts \
  packages/kozane/src/db/api/action-restoration*.test.ts \
  packages/kozane/src/db/api/action-epochs.test.ts
```

Run SQLite WASM in a browser with Chromium installed for Playwright.

```sh
KOZANE_DB_BROWSER=1 pnpm exec vitest run --config scripts/database-parity/vitest.config.ts \
  packages/kozane/src/db/api/action-capture*.test.ts \
  packages/kozane/src/db/api/action-restoration*.test.ts \
  packages/kozane/src/db/api/action-epochs.test.ts
```

The libsql and Node WASM checks pass. Browser verification is pending. Chromium
was unavailable in the implementation environment, and the environment's network
policy denied its download. Browser startup also failed because the environment
denied the local test server's listener. Keep this gate incomplete until a browser
run passes.

The test fixture also exercises [durable epoch transitions](prototype-epoch-transitions.md).
Migration progress survives restarts, committed repair is not repeated and
application writes remain blocked until the prepared baseline activates.
These are prototype boundaries without production epoch tables or activation.

## Capture before driver conversion

`packages/core/src/actions/sql-codec.ts` builds SQL expressions for use in persistent
`BEFORE` triggers. Capture uses the actual SQLite storage class. INTEGER values
become decimal strings inside SQLite, preserving the complete signed 64-bit range.
BLOB values become hexadecimal strings.

REAL values are scaled by exact powers of two inside a recursive SQL expression.
The result encodes their binary64 sign, exponent and mantissa directly. The SQL
uses `atan2` to distinguish signed zeros. Both tested engines provide this function.
Non-finite REAL values produce invalid provisional images and abort finalization.
An adapter must provide these SQL operations before it can support this prototype.

TEXT is captured provisionally as hexadecimal UTF-8 bytes. This keeps malformed
UTF-8 and embedded NUL out of driver string conversion. Inside the same write
transaction, `decodeCapturedRow` validates these bytes with a strict UTF-8 decoder
and produces the canonical tagged TEXT value. Leading byte-order marks are
preserved. Invalid bytes abort the transaction without changing the original data.
The fixture finalizes new provisional images into tagged rows before commit.

The `probe_context` and `probe_effect` tables belong only to test databases.
They are not migrations or the production action log format. The fixture and
opt-in action scopes use the shared connection configuration and verification
helpers. Node hosts, the WASM parity adapter and the restoration worker also
configure both flags. Browser runtime verification remains pending.

## Capture real service actions

`packages/kozane/src/test-utils/action-capture.ts` connects persistent capture to
the execution scope's entry, leave and completion hooks. It derives columns and
complete primary keys from all 12 shared application tables. Its baseline
includes populated rows before capture guards are installed. The `capture_*`
tables and guards exist only in test databases.

Entry persists an execution record before SQL and sets the current action marker.
Child exit restores its parent's marker. Execution ordinals count handler entries,
including no-op children. Effect ordinals count every captured row operation across
the whole root. Guards refuse missing or mismatched markers and primary-key changes,
including composite keys.

Completion finalizes provisional images and persists the finalized composition
invocation, execution inputs and generated bindings. It rebuilds the projection
from the original baseline and selected completed runs in persisted materialization
order, then compares every application row before commit. No mutable projection
state advances before commit. A failed
commit or root savepoint leaves no captured run behind, and later groups can use
the persisted history.

The integration tests use the real service registry to exercise every application
table, namespace cascades, inventory placement cleanup, orphan glue cleanup,
parent and child attribution, and zero-effect children. They also cover caught
service errors, malformed trigger-generated text, corrupt before images, phantom
capture from skipped inserts, failed commits and replay root isolation. Later
groups preserve earlier run, execution and effect rows. Local taskspace paths and
observations live in `taskspace_local` after migration 0020 and are excluded from
shared capture and projection validation. Migration 0021 adds
`local_file_operation` with the same exclusion. Shared restoration preserves
pending local operations even when their taskspace and namespace are absent.

The local Node libsql adapter executes transaction commits through the driver's
`executeMultiple` method. In the installed driver, a failed prepared `COMMIT`
retains a database lock after rollback. The exec path avoids that lock. Regression
tests verify rollback, unchanged commit revisions and a successful later write.

## Reconstruct and verify installation

`packages/core/src/actions/projection.ts` creates an unconstrained row projection.
It checks complete rows and primary keys, strictly increasing effect ordinals,
absent keys for inserts, full before images for updates and deletes, and unchanged
primary keys. A failed group leaves the earlier projection unchanged. Applying
selected groups in order creates successive projections without modifying the
baseline or earlier results.

`installationInsert` builds statements that preserve the tagged storage values.
INTEGER values bind as decimal text and are cast inside SQLite. REAL values are
rebuilt from integer mantissas and powers of two. Signed zero uses an explicit SQL
cast because SQLite arithmetic can lose its sign. TEXT and BLOB values bind in
their native forms.

`verifyInstalledRows` compares every loaded row with the target projection. It
checks complete keys, row counts, storage classes and REAL bits. The prototype
rejects installation if column affinity changes a value, and rolls back the
destination. Restoration suppresses capture and mutating business triggers.

The corpus includes signed 64-bit limits, integers outside the JavaScript safe
range, integral REAL values, signed zeros, subnormal boundaries, maximum finite
REAL values, deterministic random finite bit patterns, Unicode, embedded NUL,
leading byte-order marks, and empty and nonempty blobs. Other tests cover nested
trigger writes, repeated updates, alternate capture/business trigger creation
orders, parent-first cascade capture, corrupt before images, composite keys,
deferred commit failures and marker cleanup.

The [image-manifest integration](action-asset-manifests.md) collects required images
from baseline rows, original invocations and every full before and after image.
The fixture stores baseline rows and their manifest together and commits each
effect-set manifest with its action. Reopening reads stored baseline data rather
than recreating it. Restoration verifies selected manifests and bytes outside
SQLite transactions, then refuses installation if history changed during those
reads. Tests cover deleted intermediate images, failed commits and missing bytes.
The optional `CaptureAssetPublisher` host hook receives each exact manifest and
the capture transaction. Baseline installation calls it before committing guards
and baseline data. Action completion calls it after reconstruction checks and
before committing the completed run. Reopening accepts a new hook explicitly.
The fixture does not persist callbacks or infer a host's ownership policy.

Integration tests use the hook to reserve a local baseline or effect-set owner,
verify live or archived bytes under the writer lock and release the earlier
staging owner. These changes commit with the captured history and shared rows.
Verification, statement and deferred commit failures preserve staging protection
without publishing partial ownership. Application upload completion also rolls
back with a failed captured action. Cleanup from another connection cannot pass
the writer boundary during publication.

Images referenced only by invocations or intermediate row images remain protected
after the final card is deleted. Restoring an earlier selection preserves owners
for all retained origin history, including deselected runs. Production action
routing and automatic owner registration remain pending.

## Validate complete application projections

`actions/restoration-plan.ts` derives a deterministic load order from a trusted
schema manifest and an explicit table selection. It keeps complete composite
primary keys and reverses that order for deletion. It refuses cycles, missing
parents, generated columns and excluded tables that reference restored rows.
The current application schema has an acyclic load order. The plan is internal
and does not authorize live row replacement.

`packages/kozane/src/test-utils/action-validation.ts` loads complete target rows
into a separate, empty test database. It verifies the canonical schema before
loading and suppresses only the two mutating card triggers in that isolated
transaction. Checks, unique indexes, foreign keys and validation-only triggers
remain active. It also checks the final inventory pair invariant, runs
`foreign_key_check` and compares every loaded row with the target projection.

Tests reconstruct real cascade effects before validation. Intermediate rows stay
in the unconstrained projection. Successful loading preserves historical zero
timestamps, large integers and nonintegral REAL storage without repair. Invalid
foreign keys, NULLs, scope names, inventory pairs and unique slots abort the load.
Affinity changes also abort it, including integral REAL values and signed zero
stored in INTEGER columns. A failed load rolls back rows and trigger removal.
The source database and capture history remain unchanged. Populated or
incompatible validation destinations are refused before loading.

These checks pass on libsql and Node WASM. Epoch selection, production restore
mode and live installation remain pending.

The public core
[shared projection validator](shared-recovery-projections.md) now provides a
separate preparation boundary. It accepts complete tagged target tables and
rolls back temporary rows and trigger changes before returning. The prototype's
validator still retains rows in its test database for installation assertions.
Neither helper activates a workspace or finalizes production history storage.

The public reconstruction helper also accepts the fixture's complete baseline
and selected row effects through its explicit input format. Native and Node WASM
tests compare reconstructed cascade states with live captured rows, validate
the final projection separately and preserve all origin history and local paths.

## Replace populated rows in the fixture

The capture fixture's `restore` method accepts a fresh validation database factory
and an ordered list of captured run IDs. It reconstructs selected complete runs
while holding the destination write transaction, then validates the target in the
separate database before changing destination rows. Missing runs, duplicate
selections and incompatible before images fail before validation begins.

The fixture has an explicit restore mode. Its persistent application guards stay
installed and require an empty action marker in that mode. Capture and the two
mutating card triggers run only in record mode. Restoration deletes children
before parents, inserts parents before children, checks foreign keys and reads
back every row. The selected run list and row replacement commit together after
the context returns to record mode.

Tests restore the baseline and successive cascade states into populated rows.
They preserve historical zero timestamps and all origin invocations, bindings,
execution records and effects without allocating a clock or creating an action.
New actions append to the restored selection while retaining unselected origin
history. Validation errors, installation SQL errors and read-back mismatches
leave rows, selection and markers unchanged. Ordinary unstamped writes remain
refused after success and rollback.

This method exists only in test fixtures. It replaces shared taskspace identity
while preserving local metadata for present and absent taskspaces. Restored rows
use the device's current attachment, and fresh validation destinations receive no
source directory attachments. Tests check this alongside exact row installation.
These tests do not establish epoch activation, durable recovery or browser support.

## Remaining activation work

The prototype does not enroll a workspace, install production guards or restore
an epoch. Browser verification, production validation and epoch compatibility,
business invariant coverage and production capture integration remain pending.
Production activation must refuse any unsupported value or failed read-back
comparison. Do not treat passing these fixture checks as permission to enable
stamping on an existing workspace.
