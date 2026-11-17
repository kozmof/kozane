# Shared recovery projections

Core can validate reconstructed shared rows without installing a workspace.
Use `reconstructSharedRecoveryProjection`, `parseSharedRecoveryProjection` and
`validateSharedRecoveryProjection` from `@kozane/core/recovery` to prepare a
complete target before a future installation boundary.

## Prepare complete target rows

Supply a version 1 object with `rowEncodingVersion` set to `1`, `schemaId` set to
the current bundled migration ID and a `tables` array. Each table entry has a
`name` and a `rows` array of tagged row values. Include every shared table, even
when its rows array is empty.

The current schema requires `namespace`, `partition`, `layer`, `scope`,
`taskspace`, `inventory`, `card`, `glue`, `glue_rel`, `scope_rel`, `scope_area` and
`warp`. Local attachments, file operations, upload pins, manifest owners and
checkpoint catalog rows never belong to this projection.

Parsing refuses unsupported schemas or encodings, unknown or duplicate tables,
missing tables, incomplete rows, extra columns, duplicate keys, NULL primary
keys and malformed tagged values. Accessors and serialization hooks are refused
without invocation. The result is an immutable copy with canonical table, row
and column order.

The projection describes target rows. The host must establish workspace, epoch
and checkpoint bindings separately and retain the required history and images.

## Reconstruct selected history

Call `reconstructSharedRecoveryProjection(input, expected)` with a baseline and
exactly the selected effect-set records. The baseline has an `id` and a complete
`projection`. Each effect set has an `id` and an `effects` array. Keep complete
action, execution and asset records separately for later installation and audit.

Obtain `expected` independently from trusted completed records. It contains
`baselineId` and an ordered `effectSets` array of entries with `id` and
`effectCount`. Bind those IDs to the intended checkpoint and derive counts from
the complete retained records before receiving effect arrays. Expected counts
must not come from the received arrays being checked.

Reconstruction checks the baseline ID, requires every selected set and refuses
duplicate or unselected records. Empty selected sets still require explicit
records with a zero expected count. Received records can arrive in any order.
The expected selection controls materialization order.

Each effect has `ord`, `table`, `key`, `op`, `before` and `after`. Ordinals start
at zero and remain consecutive within each set. Operations are `I`, `U` or `D`.
Keys include every primary-key column and cannot contain NULL. Before and after
images use the tagged codec and contain every column when present. Insert before
images and delete after images are NULL. Unknown tables, local tables, malformed
transport, changed keys and count or ordinal gaps refuse reconstruction.

The helper applies effects in memory and checks each full before image against
the current row. Storage classes, unsafe integers and REAL bits remain exact.
Intermediate relationally invalid images remain outside SQLite until the full
selection is reconstructed. A later mismatch returns no partial result and
leaves the baseline and input records unchanged. The result is a canonical
immutable projection ready for isolated SQL validation.

This preparation helper does not establish authenticity, authorize action
eligibility or persist history. The host supplies the correct completed shared
records from the matching workspace and epoch. Production log storage and
durable checkpoint bindings remain pending.

## Validate in a separate database

Pass a trusted factory that owns a separate empty database and its disposal.
The validator copies the projection before awaiting the factory. It configures
and verifies foreign keys and recursive triggers, checks the complete canonical
schema and refuses existing application rows, including local rows.

Inside a savepoint, validation temporarily removes the two mutating card
triggers. Table constraints, unique indexes, foreign keys and validation-only
triggers remain active. Rows load in schema order, with parents before children.
Validation checks foreign keys and the final inventory pair invariant, then
reads every shared row through the tagged codec and compares exact values.

Signed 64-bit integers never pass through JavaScript numbers. Finite REAL bits,
TEXT, embedded NULs, leading byte-order marks, blobs, NULLs and historical zero
timestamps remain exact. SQLite affinity changes refuse validation even when
the loaded value satisfies relational constraints. Validation performs no
repair or clock allocation.

Temporary rows and trigger changes roll back before success. The outer
transaction must also commit successfully. The returned immutable projection
authorizes no installation, activation, history publication or local path use.
Failures leave the isolated database's earlier rows and schema intact.

Native and Node WASM tests cover complete targets, malformed transport, SQL
constraints, affinity changes, altered read-back, connection flags, cleanup
failures and failed outer commits. Tests also verify that all 12 shared tables
remain empty and both mutating triggers return after successful validation.

Reconstruction tests also cover selected materialization order, missing and
truncated sets, ordinal gaps, exact before images, composite keys and real
captured cascades. Source rows, local attachments and retained origin history
remain unchanged.

## Continue recovery preparation

Complete recovery on the originating device also needs the matching
[local recovery snapshot](local-recovery-snapshots.md). Shared-only restoration
and joining another device omit those attachments. Both modes still need
verified retained history, required image bytes and durable installation and
activation boundaries. Those workflows remain pending.
