# One-time local recovery installation

The recovery installer stages local rows once in a new destination database.
It preserves exact tagged values, absent taskspace metadata and pending local
operations. It does not activate the destination or execute filesystem work.

## Stage a published bundle's local snapshot

Use `installRegisteredRecoveryBundleLocalSnapshot` in
`lib/server/recovery-bundle-installation.ts` with the same source options as
[the registered bundle loader](recovery-bundles.md#reopen-a-complete-bundle).
Add a separate `destination` database that has completed the bundled migrations
and contains no application, local metadata or recovery catalog rows.

```ts
const installed = await installRegisteredRecoveryBundleLocalSnapshot({
  ...sourceOptions,
  destination,
});
```

Supply the destination host's independently trusted `expected` identity. The
workspace, device, epoch, checkpoint and schema must all match the bundle and
local snapshot. A source descriptor does not supply the destination's identity.
Another device cannot install the source device's paths through this API.

The first attempt validates the published index, every saved payload, exact
source bindings and retained image bytes. It then validates the matching local
snapshot in a separate empty canonical database. The validation factory owns
that database and its disposal. It must not return the destination.

The destination must have the exact canonical schema and complete migration
history. A seeded, populated or unsupported destination refuses installation.
The source database cannot be used as the destination. Checks run again under
the destination writer lock after source validation yields.

Local rows and one immutable installation record commit together. The installer
keeps constraints and connection checks active, verifies foreign keys and reads
back exact storage classes and values. Receipt publication cannot change the
staged rows. Any mismatch, SQL failure or failed commit rolls back the entire
attempt. Competing connections cannot install two snapshots into one destination.

The result contains the original bundle `checkpoint` and `changed`. A successful
first installation returns `changed: true`. An empty local snapshot still creates
the record and consumes this destination's one-time installation slot.

## Retry without replaying local changes

A matching record acknowledges an earlier successful local installation and
returns `changed: false`. It does not reopen bundle files, allocate validation
databases, compare current rows with the old snapshot or reapply local data.
Later local edits remain intact, including intentional removals.

A different bundle descriptor is refused even when it uses the same identities.
The record is destination-wide. Use another empty staging database for another
checkpoint. There is no overwrite or reset operation in this API.

An acknowledgement establishes that initial local staging happened. It does not
assert that current rows still equal the snapshot or that the workspace is ready
for activation. The activation coordinator must validate shared state, required
history, images and bookkeeping separately.

## Keep destination authority separate

Migration 0037 adds `local_recovery_installation`. Its single row records the
original bundle descriptor and an informational integer installation timestamp.
SQL guards prevent updates and deletion. Inspection reads descriptor metadata
without converting the timestamp to a JavaScript date.

This table belongs to the receiving database. It is excluded from shared
projections, portable local snapshots and JSON exports. JSON version 26 remains
unchanged. Imports into the same database preserve the record. Imported extra
fields cannot create installation authority in another database.

Portable snapshots still contain fourteen local tables. A source snapshot cannot
carry a destination installation record or rewind an existing one. Full database
maintenance remains separate from this controlled installation API.

## Use the core boundary

Import these helpers from `@kozane/core/recovery` when composing a trusted host.

- `installLocalRecoverySnapshot(destination, createValidationDatabase, snapshot, checkpoint, expected)` installs independently trusted local data and the record atomically.
- `checkLocalRecoveryInstallation(destination, checkpoint, expected)` checks canonical schema, migration history, exact identity and the existing record. It returns the matching descriptor, returns `null` for an eligible empty destination or refuses a conflicting or populated destination.
- `inspectLocalRecoveryInstallation(destination)` and `readLocalRecoveryInstallation(handle)` inspect the record without authorizing a new installation. The reader accepts database, transaction and read-transaction handles.
- `parseLocalRecoveryInstallationRecord(descriptor)` checks stored descriptor text. Known historical metadata remains inspectable, while actual installation requires the bundled schema.

The core installer verifies local identity, selection, canonical hash and exact
SQL values. The host remains responsible for validating bundle completeness and
protected bytes before the first call. The Node wrapper performs that source
validation for registered published bundles.

This step stages local data only. Shared rows and retained history still need
destination installation before activation. Image bytes are not copied to the
destination. Pending local operations remain records for later inspection. No
local-only effects are replayed. Taskspace file bytes and configuration files are
outside the local snapshot.
