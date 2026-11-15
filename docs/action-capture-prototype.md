# Action capture prototype

The prototype tests persistent row capture and exact installation on libsql and
SQLite WASM. Production stamping remains disabled. The browser check must pass
before the production log schema is finalized.

## Run the checks

Run the Node libsql prototype with the source test configuration.

```sh
pnpm exec vitest run --config vitest.source.config.ts packages/kozane/src/db/api/action-capture.test.ts packages/kozane/src/services/action-projection.test.ts
```

Run the same capture tests against SQLite WASM in Node.

```sh
pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-capture.test.ts
```

Run SQLite WASM in a browser with Chromium installed for Playwright.

```sh
KOZANE_DB_BROWSER=1 pnpm exec vitest run --config scripts/database-parity/vitest.config.ts packages/kozane/src/db/api/action-capture.test.ts
```

The libsql and Node WASM checks pass. Browser verification is pending. Chromium
was unavailable in the implementation environment, and the environment's network
policy denied its download. Browser startup also failed because the environment
denied the local test server's listener. Keep this gate incomplete until a browser
run passes.

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
They are not migrations or the production action log format. The fixture sets and
verifies foreign keys and recursive triggers on the connections it uses. Production
adapter connection setup and action attribution remain separate work.

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

## Remaining activation work

The prototype does not enroll a workspace, install production guards or restore
an epoch. Browser verification, isolated final-state validation, epoch schema
compatibility, business invariants and production connection setup remain pending.
Production activation must refuse any unsupported value or failed read-back
comparison. Do not treat passing these fixture checks as permission to enable
stamping on an existing workspace.
