# Published recovery bundles

The Node host can publish a recovery index after validating its saved payloads
and protected image bytes. Use `saveRegisteredRecoveryBundle`,
`loadRegisteredRecoveryBundle` and `inspectRecoveryBundlePublication` in
`lib/server/recovery-bundle.ts` for registered checkpoints.

A bundle consists of the published index, its eight referenced payload files and
protected images in the workspace root. The index alone is not a portable backup
or an installation receipt. Keep all referenced files and image protection until
the bundle is retired.

## Prepare the sources

Save all eight matching payloads before publishing an index. They contain the
local snapshot, selected shared history, selected executions, current originals,
broader action archive, broader run archive, current asset manifests and broader
run manifests. See [saved broader manifests](run-archive-asset-payloads.md) for
the source workflow.

Establish complete root, action and run inventories before preparing their
trusted descriptors. Bundle publication verifies those declared contents. It
does not discover records omitted from the trusted inventories.

Prepare a [bundle index](recovery-bundle-indexes.md) from the original payloads.
When assembling from saved files, use `loadRegisteredRunArchiveAssetContents` in
`lib/server/run-archive-asset-payload.ts`. It returns the validated manifest
`payload`, its `checkpoint` and all seven `sources`. Pass those sources and the
manifest payload to the core index preparation helper.

Preserve the bundle descriptor independently of received index data. Every source must
still match its original registered expectation, including the exact local
binding on each dependent descriptor. Later local writes require a new snapshot
and checkpoint identity.

## Publish the index

Supply `root`, the trusted catalog `db`, the full host `expected` identity and the
original bundle `checkpoint`. Supply all eight source byte limits as positive
safe integers. Registered lengths above their limits cause failure before file
reads or SQL allocation. Parsing and validation require additional memory.

Supply a `createValidationDatabase` factory that owns separate empty canonical
databases and their disposal. Source validation may call it several times. It
checks exact local and shared values and both endpoints of every archived run.

Publish using the prepared index.

```ts
const options = {
  root,
  db,
  expected,
  checkpoint: bundle.checkpoint,
  localMaxBytes,
  sharedMaxBytes,
  executionMaxBytes,
  actionMaxBytes,
  actionArchiveMaxBytes,
  runArchiveMaxBytes,
  assetMaxBytes,
  runAssetMaxBytes,
  createValidationDatabase,
};
const saved = await saveRegisteredRecoveryBundle({
  ...options,
  input: bundle.index,
});
```

The writer owns its inputs before awaiting work. It verifies canonical index
contents before source SQL allocation, loads all eight saved payloads and checks
source hashes and independent image coverage. Missing local snapshots or changed
source bindings refuse publication. Validation does not run action handlers or
install application rows or local snapshots.

The writer commits pending image protection before reading image bytes. It uses
the stable recovery owner from the checkpoint identity. Existing owners cannot
be expanded to a different manifest. Prepare a new checkpoint for changed
requirements and retain earlier pins until the replacement reservation commits.

Image verification and index publication share the image writer transaction.
All eight original catalog bindings and saved files are rechecked before and
after byte verification and publication. Every source must have matching final
bytes and no temporary evidence. Images may be live or archived. Images used only
by skipped or never-executed originals remain required.

Indexes live under `.kozane/recovery/bundle-indexes`. Their published names use
the lowercase index SHA-256 followed by `.json`. Temporary names use
`.pending-<digest>.json`. Checkpoint identifiers never become path components.

Publication creates a temporary file exclusively with mode `0600`, writes
canonical UTF-8 bytes and syncs the file. It verifies the bytes, publishes with an
exclusive hard link, removes the temporary name and syncs the directory.
Directory sync is skipped on Windows. The file itself is always synced. Matching
existing final bytes are verified without rewriting them. Different or unsafe
paths and any temporary index evidence require review.

The result contains `path`, `index`, the original `checkpoint`, the image `owner`
and `changed`. The flag records whether index bytes were newly published. Image
protection may also change during an explicit retry.

## Inspect interrupted publication

Call `inspectRecoveryBundlePublication(root, checkpoint)` with the original
independently retained descriptor. Inspection reports published and temporary
file evidence without creating paths, removing files or consulting catalogs.
Known historical and orphaned evidence remains inspectable.

Failed writes, syncs, links, source checks or commits preserve earlier pins and
file evidence. A failed final commit may leave matching published bytes with
pending protection. That candidate remains unusable through the loader. A final
file alone never establishes completeness.

An explicit save retry can verify matching final bytes when the temporary path
is absent and all original sources and image requirements still match. The retry
can commit retained protection without rewriting the index. There is no automatic
retry, replacement or cleanup. Earlier retained protection survives failures.

## Reopen a complete bundle

Call `loadRegisteredRecoveryBundle` with the same options and add `maxBytes` for
the index. All nine limits must be positive safe integers. The reader accepts
only published index bytes matching the independently trusted descriptor.
Temporary evidence, invalid UTF-8 JSON and noncanonical contents refuse loading
before source SQL allocation.

```ts
const reopened = await loadRegisteredRecoveryBundle({
  ...options,
  maxBytes: indexMaxBytes,
});
```

The reader reloads all eight sources and verifies exact SQL values, source
contents, invocation coverage and image requirements. Under the image writer
lock, it requires an existing retained owner with exactly the expected manifest.
It rechecks physical image bytes and every original source binding and file.
Absent, pending or released protection refuses loading. Loading does not create,
expand or promote an image owner.

The index must retain its file identity, length and modification metadata
throughout validation. Replaced, rewritten or removed indexes and new temporary
evidence cause failure, including rewrites with matching bytes. Failures preserve
all earlier protection.

The immutable result contains `index`, `checkpoint`, `owner` and `contents` with
all eight validated payloads. Loading performs no writes to recovery files,
installs no images or live rows and does not activate a workspace. Use the loader
again when completeness must be established. A prior observation or retained
owner state is not a durable publication or installation receipt.

The host can [stage the local snapshot once](local-recovery-installation.md)
in a separate empty destination. Automatic capture, shared-state and image
installation and activation remain separate requirements. Pending filesystem operations remain
recovery data and are not executed by publication or loading.
