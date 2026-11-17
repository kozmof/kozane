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

Parsing validates transport shape and exact row encoding. SQL validation uses the
separate isolated boundary below. Neither step validates operation intent or
authorizes local path use. A future installation boundary must check those
conditions before loading the snapshot once on its originating device.
Shared-only restoration and joining another device must continue to omit source
attachments.

## Validate rows in an isolated database

`validateLocalRecoverySnapshot` in `actions/local-recovery-validation.ts` checks
identity, copies transport and validates local asset metadata before calling a
trusted database factory. The factory supplies a separate empty database and owns
its disposal. The helper
configures and verifies foreign keys and recursive triggers, checks the complete
bundled schema and refuses existing shared or local application rows.

Validation loads the tagged rows under the database's SQL constraints. It leaves
constraints and triggers installed, checks foreign keys and reads every local row
back through the tagged codec. Storage classes and exact REAL bits must match.
An INTEGER column converting an integral REAL value to INTEGER therefore refuses
validation, even when the value satisfies SQL constraints.

The helper rolls temporary rows back to its savepoint after validation. Success
returns an immutable snapshot only after savepoint cleanup and the outer
transaction commit succeed. The validation database retains no attachments,
operations or pins. Failures roll back temporary writes as well. Existing rows in
a refused database remain intact. The source database is never passed to this
write boundary.

Native and WASM tests cover constraints, affinity changes, altered read-back,
changed connection flags, cleanup failures and failed commits. They also verify
that mismatched identities refuse validation before allocating a database and
that existing validation rows are preserved when the destination is refused.

SQL validation does not publish a recovery bundle or establish that image bytes
are available. It does not replace the host's operation and path validation or
the future one-time installation boundary.

## Collect and protect checkpoint images

`localRecoveryAssetManifest` in `actions/local-recovery-assets.ts` collects image
requirements from the snapshot. Pending and installed uploads require their
recorded bytes. Pending and retained manifest owners require every listed image.
Completed or abandoned uploads and released owners retain name identity without
requiring their old files.

Pass the selected shared baseline and effect-set manifests as the second argument
when assembling checkpoint requirements. The helper includes those images and
checks them against every local identity record, including inactive records.
Different hashes or lengths under one name are refused. The host must obtain
those manifests from the checkpoint's complete retained history. The helper does
not establish that correspondence or retain history itself.

All local asset metadata must remain well formed, including inactive entries.
Malformed names, lengths, hashes, owner kinds, states and manifest JSON refuse
collection. SQL snapshot validation runs these checks before allocating its
validation database. Collection returns immutable metadata and does not read or
change files.

A pending requirement remains required even if file creation never completed.
Metadata collection does not establish availability. Missing required bytes must
block complete bundle publication until the pending work is resolved. Do not drop
the requirement or abandon its owner automatically.

Reserve the combined manifest under a recovery owner before verifying bytes.
Keep earlier protection until that reservation commits. Verify the reserved
files through the [local manifest ledger](asset-manifest-retention.md) before
publication. Missing or changed bytes leave the recovery owner pending. Keeping
this owner active protects the checkpoint independently of earlier upload and
transfer decisions.

Native and WASM tests cover every owner kind and upload state, shared-history
requirements, inactive identity conflicts and malformed metadata. Node tests
transfer protection to a recovery owner and run cleanup before and after byte
verification. They also preserve pending protection when a required file is
missing. These checks exercise asset retention without publishing a bundle.

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
