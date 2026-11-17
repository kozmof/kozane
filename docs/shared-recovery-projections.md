# Shared recovery projections

Core can validate reconstructed shared rows without installing a workspace.
Use `parseSharedRecoveryProjection` and `validateSharedRecoveryProjection` from
`@kozane/core/recovery` to prepare a complete target before a future installation
boundary.

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

The projection describes target rows. It carries no trusted workspace, epoch or
checkpoint binding and does not prove that selected history is complete. The
host must reconstruct it from the correct baseline and ordered complete effect
sets, check full before images and establish those identities separately.

## Validate in a separate database

Pass a trusted factory that owns a separate empty database and its disposal.
The validator copies the projection before awaiting the factory. It configures
and verifies foreign keys and recursive triggers, checks the complete canonical
schema and refuses existing application rows, including local rows.

Inside a savepoint, validation temporarily removes the two mutating card
triggers. Table constraints, unique indexes, foreign keys and validation-only
triggers remain active. Rows load in the schema's parent-before-child order.
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

## Continue recovery preparation

Complete recovery on the originating device also needs the matching
[local recovery snapshot](local-recovery-snapshots.md). Shared-only restoration
and joining another device omit those attachments. Both modes still need
verified retained history, required image bytes and durable installation and
activation boundaries. Those workflows remain pending.
