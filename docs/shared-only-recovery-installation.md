# Shared-only recovery installation

Shared-only recovery stages shared application rows in a new destination without
copying the source device's local attachments or pending filesystem operations.
Choose this path explicitly when recovering onto another device.

## Choose a new destination and its identity

Use `installRegisteredRecoveryBundleSharedOnlySnapshot` from
`lib/server/recovery-bundle-installation.ts`. Supply the source options from
[the registered bundle loader](recovery-bundles.md#reopen-a-complete-bundle), a
separate `destination` database and an independently trusted
`destinationExpected` identity.

```ts
const installed = await installRegisteredRecoveryBundleSharedOnlySnapshot({
  ...sourceOptions,
  destination,
  destinationExpected,
});
```

`sourceOptions.expected` identifies the originating bundle. `destinationExpected`
identifies the receiving host. Both must use the same workspace, epoch,
checkpoint and bundled schema. Their device IDs may differ. Supply both
identities independently rather than deriving destination authority from source
transport. Explicit shared-only recovery also works on the originating device.

The destination must have the exact canonical schema and complete migration
history. Temporary schema objects are refused so they cannot shadow destination
tables. Every application, local metadata and installation table must be empty.
A seeded destination, an independent populated workspace or an earlier complete
recovery installation is refused. This path does not switch modes or merge work.
Keep any existing independent workspace separately.

## Validate the source and stage shared rows

The first attempt requires a complete published source bundle. The host reloads
all eight saved payloads, checks their exact catalog bindings and verifies
retained image protection and physical source bytes. A missing source local
snapshot still makes that published bundle incomplete. It is validated as source
evidence and is never installed in the receiving database.

The installer verifies the selected shared history's identity, length, hash and
selection. It reconstructs the target projection and validates it in a separate
empty SQL database. The validation factory owns that database and its disposal.
It must not return the destination.

Checks run again under the destination writer lock. Shared rows and one immutable
`shared_only_recovery_installation` record commit together. Parents load before
children. Constraints and validation triggers stay active. The two mutating
business triggers are suppressed during loading and restored before commit.

Exact tagged read-back verifies storage classes, full integers, REAL bits and
TEXT. Protected metadata, migration history, canonical schema and required
connection flags are checked before commit. SQL failures, changed values and
failed commits roll back the whole attempt. Competing connections cannot publish
two installations or observe partial rows and installation authority.

All fourteen portable local tables start empty. Source paths, observations,
uploads, manifests, checkpoint catalogs and pending file operations are not
copied. Neither a local installation record nor a complete shared installation
record is created. Filesystem callbacks do not run.

## Retry without replacing receiving-device work

The result contains the source bundle `checkpoint`, the original
`destinationIdentity` and `changed`. The first successful attempt returns
`changed: true`. An empty shared projection still consumes the one-time slot.

A matching retry returns `changed: false` without reopening source files,
allocating validation databases or replaying rows. Later shared edits and local
attachments created on the receiving device remain intact. Another bundle or
receiving device is refused.

The record keeps this path separate from complete local recovery. Later calls to
the local-snapshot or complete shared installer cannot attach the old source
snapshot through this destination. Use a new destination to choose another
recovery path. There is no overwrite or reset operation in these APIs.

The record acknowledges initial shared-only staging. It does not establish that
current rows still equal the original projection or authorize activation.
Continue with [destination image installation](recovery-image-installation.md)
to copy and verify required bytes. Required history, materialization bookkeeping
and activation remain separate requirements. This workflow does not join a sync hub by itself.

## Inspect destination authority

Migration 0039 adds the singleton `shared_only_recovery_installation`. Its record
contains the original source bundle descriptor, the receiving identity and an
informational integer timestamp. SQL guards prevent updates and deletion.
Inspection does not convert that timestamp to a JavaScript date.

The record is excluded from portable local snapshots, shared projections and
JSON exports. Portable snapshots still contain fourteen tables and JSON remains
version 26. Imports into the same database preserve installation authority.
Transported extra tables cannot create it in another destination. Full database
maintenance remains separate from these controlled staging APIs.

## Compose a trusted core host

Import these helpers and `SharedOnlyRecoveryInstallation` from
`@kozane/core/recovery`.

- `installSharedOnlyRecoverySnapshot(destination, createValidationDatabase, sharedHistory, checkpoint, expected, destinationExpected)` validates selected shared contents and stages exact rows with the receiving record.
- `checkSharedOnlyRecoveryInstallation(destination, checkpoint, expected, destinationExpected)` returns the matching record, returns `null` for an eligible empty destination or refuses the destination.
- `inspectSharedOnlyRecoveryInstallation(destination)` and `readSharedOnlyRecoveryInstallation(handle)` inspect metadata. The reader accepts database, transaction and read-transaction handles.
- `parseSharedOnlyRecoveryInstallationRecord(descriptor, destinationDescriptor)` parses the two stored TEXT descriptors. Known historical metadata remains inspectable without authorizing installation.

A trusted core host must verify complete source contents and protected bytes
before the first call. The Node wrapper performs those checks for registered
published bundles. This API stages only the selected shared projection and does
not install broader archived actions, executions or retained runs.

Continue with [destination image installation](recovery-image-installation.md)
after the required row staging completes. It retains destination image protection
without activating the workspace or repeating taskspace filesystem operations.
