# Retain a bundle in a staged recovery destination

Retain a published bundle's payload files beside the staged rows and images.
The destination loader can then verify those artifacts without the original
workspace database, catalogs or files.

## Stage rows and images first

Complete either [complete staging](shared-recovery-installation.md) or
[shared-only staging](shared-only-recovery-installation.md), then
[install destination images](recovery-image-installation.md).
Use the same independently trusted bundle descriptor, originating identity,
receiving identity and explicit recovery mode throughout.

Retain the payloads with the Node host helper.

```ts
import {
  retainRegisteredRecoveryBundleInDestination,
} from "./lib/server/staged-recovery-bundle.js";

const retained = await retainRegisteredRecoveryBundleInDestination({
  ...sourceOptions,
  destination,
  destinationRoot,
  destinationExpected,
  mode: "complete",
});
```

`sourceOptions` supplies the registered source database and root, trusted
descriptor and originating identity, validation database factory and all nine
read limits from [the bundle loader](recovery-bundles.md#reopen-a-complete-bundle).
Source and destination databases and root directories must be separate.

Retention reloads the complete published source bundle. It checks every saved
payload and source binding, isolated SQL states and protected source images.
The destination must already have the matching retained image owner and verified
physical bytes. Pending or released protection cannot authorize publication.

## Retain complete artifacts

Files are stored under `.kozane/recovery/staged-bundles/<sha256>.json` using
their original canonical bytes and descriptors. The eight payloads are published
before the bundle index. Exclusive temporary files are synced and linked into
place without overwriting existing evidence. Matching final files are reused.

Publication holds the destination image writer lock through staging checks,
image verification, file publication and the final checks. Cleanup and owner
release cannot change protection during that transaction. Retention neither
creates another owner nor releases source or destination protection.

The result contains the staging metadata, `index`, `contents`, `owner`, `copied`,
`reused` and `changed`. The counters cover nine artifact files. A matching retry
returns `changed: false` after revalidating the source bundle and destination.

Temporary files, symlinks and conflicting bytes refuse publication. Earlier
final files and interruption evidence remain for review. A failed database
commit cannot return success, but published files remain reusable on an explicit
retry. The earlier retained image protection remains intact.

## Reopen without the source workspace

Use the destination database and root with independently retained expectations.
Keep all nine byte limits and supply a separate empty validation database factory.
The host owns disposal of every validation database.

```ts
const bundle = await loadStagedRecoveryBundle({
  db: destination,
  root: destinationRoot,
  checkpoint,
  expected: originatingIdentity,
  destinationExpected,
  mode: "complete",
  createValidationDatabase,
  ...readLimits,
});
```

`loadStagedRecoveryBundle` is exported from the same Node host module. It owns
the caller's inputs before asynchronous work. It validates staging metadata,
requires retained protection and reads all nine files within their individual
limits. Missing, changed or temporary artifacts refuse the load before SQL
allocation.

The loader verifies canonical hashes, source relationships, run inventories and
complete image requirements. It validates the local snapshot, selected shared
projection and each archived run's SQL endpoints in separate databases. It then
rechecks staging, retained destination protection, physical images and every
artifact's file identity under the writer lock. Concurrent changes or failed
transaction completion refuse success. Returned contents are immutable.

## Keep retention separate from activation

These files retain the original bundle, including its originating local snapshot.
Shared-only retention keeps that snapshot as an artifact without installing its
paths, uploads, pending operations or source catalog authority in the receiving
database. Later destination edits remain intact.

An index file is not an installation receipt. A retained image owner is not
activation authority. Every load verifies the complete artifact set and the
chosen destination root again. Retention does not install production history
tables or materialization bookkeeping, select an epoch, join a sync hub or
activate application writes. Those steps remain pending.
