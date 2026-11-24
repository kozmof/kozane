# One-time shared recovery installation

The shared recovery installer stages reconstructed application rows once after
the matching local snapshot has been installed. It preserves the destination's
current local metadata and records its own successful commit.

## Stage shared rows from the same bundle

Use `installRegisteredRecoveryBundleSharedSnapshot` from
`lib/server/recovery-bundle-installation.ts` after
[local installation](local-recovery-installation.md). Supply the same source
options, independently trusted `expected` identity, bundle `checkpoint` and
separate `destination` database.

```ts
await installRegisteredRecoveryBundleLocalSnapshot({ ...sourceOptions, destination });
const installed = await installRegisteredRecoveryBundleSharedSnapshot({
  ...sourceOptions,
  destination,
});
```

The destination must have the complete bundled migration history, the exact
canonical schema, the matching immutable local installation record and twelve
empty shared tables. A populated shared destination is refused. This workflow
uses the originating device's identity. Choose
[shared-only staging](shared-only-recovery-installation.md) explicitly to recover
without source local attachments on this or another device.

The first shared attempt reloads the complete published bundle. It checks all
eight saved payloads, exact catalog bindings, retained protection and physical
image bytes. It then verifies the selected shared history's canonical length and
hash, reconstructs the selected projection and validates it in a separate empty
SQL database. The validation factory owns that database and its disposal. It must
not return the destination.

Destination checks run again under the writer lock. Current local rows are
captured with the tagged codec before shared loading. Local edits since the
original snapshot, including edits made while validation yields, are preserved.
The local record acknowledges the earlier local staging step. It does not cause
the old local snapshot to be loaded again.

## Commit exact rows and one record

Shared rows and `shared_recovery_installation` commit in one transaction.
Parents load before children under active constraints and foreign keys. The
installer temporarily removes the two business triggers that would normalize
inventory slots or missing timestamps. It restores their original definitions
before publishing the record. Validation triggers remain active.

The installer checks foreign keys, inventory-pair invariants and every tagged
row image, including storage classes, full integers, exact REAL bits and TEXT
with embedded NUL characters. It compares all protected local rows, the local
installation record and migration history after receipt publication. It also
rechecks the canonical schema and required connection flags before commit.

SQL errors, changed rows, changed metadata, missing triggers and failed commits
roll back the whole step. A failed shared attempt preserves the earlier local
installation. Other connections see no partial shared rows or shared record.
Concurrent attempts cannot publish two installations.

## Retry without replacing later edits

The result contains `checkpoint` and `changed`. The first successful attempt
returns `changed: true`. An empty reconstructed projection still consumes the
one-time slot.

A matching shared record returns `changed: false` without reading source files,
allocating validation databases or replaying rows. Later shared and local edits
remain intact. A different descriptor is refused. There is no replacement or
reset operation in this API.

The record acknowledges the initial projection installation. It does not assert
that current rows still equal the recovered projection or that the workspace is
ready for activation. Required history, bookkeeping and destination image bytes
still need installation and validation. Neither staging call activates a
workspace or repeats pending filesystem operations.

## Inspect destination metadata

Migration 0038 adds the immutable singleton `shared_recovery_installation`.
It stores the original bundle descriptor and an informational integer timestamp.
Inspection reads descriptor metadata without converting the timestamp to a
JavaScript date. Known historical descriptors remain inspectable, while actual
installation requires the bundled schema and matching host identity.

Destination installation records stay outside portable local snapshots,
shared projections and JSON dumps. Portable snapshots retain fourteen tables and
JSON remains version 26. Imports into the same database preserve these records.
Extra transported tables cannot create destination installation authority.

## Compose a trusted core host

Import these helpers from `@kozane/core/recovery`.

- `installSharedRecoverySnapshot(destination, createValidationDatabase, sharedHistory, checkpoint, expected)` validates the selected shared payload and stages exact rows with the record.
- `checkSharedRecoveryInstallation(destination, checkpoint, expected)` checks schema, complete migration history and matching local authority. It returns a matching shared descriptor, returns `null` when shared tables are eligible for first staging or refuses the destination.
- `inspectSharedRecoveryInstallation(destination)` and `readSharedRecoveryInstallation(handle)` inspect metadata without authorizing installation. The reader accepts database, transaction and read-transaction handles.
- `parseSharedRecoveryInstallationRecord(descriptor)` parses stored descriptor text without authorizing historical installation.

The host must validate complete bundle contents and protected source image bytes
before the first core call. The Node wrapper performs those checks for registered
published bundles. These APIs install only the selected shared projection.
Broader original actions, executions, deselected runs, retained history and
materialization bookkeeping remain separate destination requirements.
