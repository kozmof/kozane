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
| `local_recovery_checkpoint` | Previously registered checkpoint descriptors and registration timestamps |
| `local_recovery_shared_history` | Shared-history descriptors, their original local descriptor bindings and registration timestamps |
| `local_recovery_assets` | Asset descriptors bound to original shared/local expectations and registration timestamps |
| `local_recovery_executions` | Selected-execution descriptors, original local bindings and registration timestamps |
| `local_recovery_actions` | Original-action descriptors, original local bindings and registration timestamps |
| `local_recovery_retained_history` | Retained-run descriptors, original local bindings and registration timestamps |
| `local_recovery_retained_assets` | Retained-manifest descriptors with exact source bindings and registration timestamps |

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

## Bind a checkpoint to snapshot contents

`captureLocalRecoveryCheckpoint` in `actions/local-recovery-checkpoint.ts` captures
the snapshot and returns it with a version 1 content descriptor. Hashing starts
after the consistent read transaction closes. `describeLocalRecoverySnapshot`
creates the same descriptor for an already captured snapshot.

The descriptor records the workspace, device, epoch, checkpoint and schema
identities, the ordered history selection, the canonical UTF-8 byte length and a
lowercase SHA-256 digest. Canonicalization removes incoming JSON whitespace and
object, table and row ordering differences. It preserves materialization order
and every tagged value. TEXT cells remain exact, including cells that themselves
contain JSON. Reformatting a stored intent or manifest string changes the digest.

Retain the expected descriptor separately from received snapshot data.
`requireLocalRecoveryCheckpoint` compares identity and selection before hashing,
then verifies byte length and content hash. Caller mutation while hashing cannot
change the copied snapshot or expected descriptor. A changed row under an
unchanged checkpoint ID is refused, including a same-length edit or a change to
an integer beyond JavaScript's safe range.

`validateLocalRecoveryCheckpoint` verifies the descriptor and the host's expected
identity before allocating an isolated validation database. It then runs the SQL
validation below. A matching hash alone does not prove that rows satisfy SQL
constraints or preserve their storage classes when loaded.

These descriptors bind known contents. They are not signatures or durable
installation receipts. Recomputing a descriptor from an untrusted snapshot does
not establish authenticity. Bundle publication and one-time receipt integration
remain pending.

## Retain trusted descriptors

Migration 0027 adds `local_recovery_checkpoint`, a local catalog with no foreign
keys to shared rows. `rememberLocalRecoveryCheckpoint` in
`actions/local-recovery-store.ts` stores a trusted descriptor under its workspace,
device, epoch and checkpoint identity. The transaction-bound variant shares a
host-owned commit. Both acquire the database writer lock before checking the key.

Repeating the same descriptor is idempotent and preserves its registration time.
Another hash, byte length, selection or schema cannot replace it under the same
identity. Read helpers validate the descriptor and its row identity without
converting the registration timestamp to a JavaScript date. There is no catalog
deletion API or automatic expiry.

Capture and hash the snapshot before registering its descriptor. The snapshot
therefore excludes its own registration, while later snapshots include prior
catalog records. Save the original payload separately. The catalog stores no
snapshot bytes, action history or publication state. A retry must use the saved
payload and descriptor. A fresh capture needs a new checkpoint identity.

The Node host now provides [saved snapshot payloads](local-recovery-payloads.md)
with immutable filenames, committed catalog intent before disk work and read-only
inspection of interrupted publication. Its bounded reader verifies published
bytes against trusted identity and SQL constraints before returning a snapshot.
Complete bundle publication and activation remain pending.

Known historical schema descriptors remain readable as metadata. Loading their
snapshot rows still requires explicit schema compatibility. Unknown schema IDs
and malformed stored descriptors are refused. The public core entry exports the
descriptor parsers and types for host bookkeeping. JSON version 23 includes
catalog records, and older supported dumps import with an empty catalog when it
is absent. Import validates descriptor shape and row identity without installing
snapshots.

Shared capture and restoration exclude the catalog. Local checkpoint capture
includes its exact rows and timestamps, and isolated validation checks every
stored descriptor before allocating a database. Native and WASM tests cover
idempotency, changed-content refusal, history preservation and migration rollback.
A native test covers competing registrations and reopening a committed record.

Registration records the host's trusted expectation. It does not verify image
availability, pin files, enroll a workspace or publish a complete bundle. Do not
register a descriptor solely because it accompanied received snapshot data.

Migration 0028 also retains
[shared-history descriptor bindings](shared-recovery-projections.md#retain-trusted-shared-descriptors).
Registration checks the local descriptor's identity and selected history IDs,
then preserves its original contents beside the shared expectation. This sixth
local table remains outside shared reconstruction and survives shared row
replacement. Local SQL validation checks every nested descriptor pair before
allocating its isolated database.

Migration 0029 retains
[trusted asset descriptors](recovery-asset-checkpoints.md#retain-trusted-asset-descriptors)
bound to the exact original shared/local pair. This seventh local table also
survives shared replacement. Local SQL validation checks every nested asset
descriptor before allocating a database. The catalog stores expectations while
manifest payloads and image bytes remain separate requirements.

Migration 0030 adds
[trusted execution expectations](shared-recovery-executions.md#retain-trusted-execution-descriptors).
This eighth local table preserves both original source bindings. Shared row
replacement retains it, and local validation checks every nested descriptor pair
before database allocation. Execution payload bytes remain a separate storage
requirement.

Migration 0031 adds
[trusted original-action expectations](shared-recovery-actions.md#retain-trusted-action-descriptors).
This ninth local table binds first-recorded contents to the exact original
execution, shared and local expectations. It survives shared replacement.
Local validation checks every nested descriptor before allocating a database.
Registration stores expectations while original payload bytes use
[separate host storage](shared-recovery-action-payloads.md).

Migration 0032 adds
[trusted retained-history expectations](shared-recovery-retained-history.md#retain-trusted-descriptors).
This tenth local table binds the complete per-run inventory to all four original
sources. Shared replacement preserves it. Local validation parses every nested
descriptor before SQL allocation, and JSON export version 23 preserves current,
historical and orphaned metadata.

Migration 0033 adds
[trusted retained-manifest expectations](retained-recovery-asset-checkpoints.md#retain-trusted-descriptors).
This eleventh local table binds per-run and original-input requirements to all
six original sources. Shared replacement preserves it. Local validation parses
every nested descriptor before SQL allocation, and JSON export version 23
preserves historical and orphaned records.

## Validate against a retained catalog binding

`validateStoredLocalRecoveryCheckpoint` accepts the trusted catalog database, a
separate validation database factory, the snapshot and the host's expected
identity. It copies snapshot rows and identity before reading the registered
descriptor. Missing registrations, mismatched identities and changed payloads
refuse preparation before the factory is called. Catalog rows carried inside the
snapshot never establish that expectation.

Hash verification and isolated SQL validation run after the catalog read
transaction closes. The helper then reads the registered binding again. Removing
or replacing it during preparation refuses success. Unrelated registrations and
equivalent descriptor JSON formatting do not change the expected binding.
No temporary validation rows are retained on either outcome.

Native and WASM tests cover missing or malformed expectations, forged transport
catalog rows, identity and content changes, source binding changes and caller
mutation while catalog reads are pending. A matching stored descriptor still
requires SQL constraint and exact read-back checks.

This is a preparation boundary. It does not install local rows or record an
installation receipt. Future activation must enforce its durable gate inside the
installation transaction and preserve required history and image protection.

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

The Node host also provides a
[registered checkpoint image workflow](local-recovery-payloads.md#protect-checkpoint-images).
It reads a saved payload, checks selected history IDs and commits a stable
recovery owner before image verification. The host remains responsible for
obtaining manifests from complete retained history. Missing bytes or a failed
verification commit leave the pending reservation protected.

## Remaining recovery work

Shared target rows can be prepared through the separate
[shared projection validator](shared-recovery-projections.md). It excludes all
local tables and validates exact values without retaining temporary rows. The
host must still reconstruct the correct selected history and bind both
projections to the same trusted checkpoint before installation.

Durable workspace and epoch enrollment, complete bundle assembly and installation
remain pending. The current selection records a
baseline and ordered effect sets. Sync queues and cursors still need a compatible
checkpoint format when those stores are implemented.

The snapshot contains database records, not image, taskspace or config file bytes.
Capturing manifest owners does not create new asset protection for a bundle.
Bundle publication must retain the selected history and register a recovery owner
through the [local manifest ledger](asset-manifest-retention.md). Publish only
after the required history, snapshot and verified assets are available. Loading
pending records must not repeat filesystem callbacks.
