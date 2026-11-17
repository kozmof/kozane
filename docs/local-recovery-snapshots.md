# Local recovery snapshots

The internal `actions/local-recovery.ts` helper captures local database rows and a
shared-history selection from one consistent read transaction. It provides a
versioned transport format for future recovery bundles. It does not publish a
bundle, install local rows or activate a workspace.

## Capture one checkpoint

`captureLocalRecoverySnapshot` accepts a database, checkpoint identities and a
selection reader. The host supplies workspace, device, epoch and checkpoint IDs
plus the current bundled migration ID. The helper copies those identities before
opening the read boundary. It does not allocate or persist them.

The selection reader receives that transaction's read handle. Read the baseline
ID and ordered effect-set IDs through this handle. Do not open another connection
or use a selection cached before the transaction. The host remains responsible
for checking that those IDs identify complete retained history.

The helper verifies the canonical local schema and captures every row from these
tables, including explicit empty tables.

| Table | Retained data |
| --- | --- |
| `taskspace_local` | Current attachments and observations, including absent taskspaces |
| `local_file_operation` | Pending, confirmed and abandoned operations and their evidence |
| `local_image_upload` | Upload intent, installation evidence, errors and decisions |
| `local_asset_manifest` | Pending, retained and released owners and their manifests |

SQL encodes values before driver conversion. The version 1 tagged row codec keeps
signed 64-bit integers as decimal strings and preserves finite REAL bits, TEXT,
embedded NULs, blobs and NULL. Unsupported values fail capture without returning a
partial snapshot. Snapshot capture performs no repair or filesystem work.

Native and WASM tests cover exact values, empty tables, schema mismatches and
failed readers. A native two-connection test commits a new selection and local
rows while capture is reading. The snapshot retains both earlier values, and a
later capture sees both newer values.

## Validate transport and identity

`parseLocalRecoverySnapshot` validates the format and row encoding versions,
identities, selection and complete local table coverage. It refuses unknown or
duplicate tables, missing or extra columns, duplicate row keys, NULL primary keys
and malformed tagged values. Accessors and serialization hooks are rejected
without invocation.

Parsing produces immutable copies. Table names, primary keys and column names
have canonical ordering. Effect-set IDs retain their materialization order.
Canonical JSON is independent of incoming table, row and column order.

`requireLocalRecoveryIdentity` compares every identity with the host's expected
checkpoint. A different device, workspace, epoch, checkpoint or schema is refused.
The current format accepts only the bundled schema. There is no implicit snapshot
migration or device reassignment.

These checks validate transport shape and exact row encoding. They do not run the
destination's SQL constraints, validate operation intent or authorize local path
use. A future installation boundary must validate those conditions before loading
the snapshot once on its originating device. Shared-only restoration and joining
another device must continue to omit source attachments.

## Remaining recovery work

Durable workspace and epoch enrollment, checkpoint persistence, complete bundle
assembly and installation remain pending. The current selection records a
baseline and ordered effect sets. Sync queues and cursors still need a compatible
checkpoint format when those stores are implemented.

The snapshot contains database records, not image, taskspace or config file bytes.
Capturing manifest owners does not create new asset protection for a bundle.
Bundle publication must retain the selected history and register a recovery owner
through the [local manifest ledger](asset-manifest-retention.md). Publish only
after the required history, snapshot and verified assets are available. Loading
pending records must not repeat filesystem callbacks.
