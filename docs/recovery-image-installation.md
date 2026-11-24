# Install images in a staged recovery destination

Recovery image installation copies a published bundle's required image bytes into
a staged destination. It reserves protection before creating files and verifies
local bytes before marking that protection retained.

## Complete row staging first

Use `installRegisteredRecoveryBundleImages` from
`lib/server/recovery-image-installation.ts` after either
[complete shared staging](shared-recovery-installation.md) or
[explicit shared-only staging](shared-only-recovery-installation.md).

```ts
const installed = await installRegisteredRecoveryBundleImages({
  ...sourceOptions,
  destination,
  destinationRoot,
  destinationExpected,
  mode: "complete",
});
```

`sourceOptions` supplies the same descriptor, originating identity, database,
root, validation factory and nine read limits as
[the registered bundle loader](recovery-bundles.md#reopen-a-complete-bundle).
Supply a separate destination database and an existing destination workspace
root. Source and destination roots must identify different directories.

Choose `mode: "complete"` when the matching local and shared installation records
exist. The independently trusted receiving identity must match the originating
device. Choose `mode: "shared-only"` for the matching shared-only record and its
original receiving identity. Another bundle, device or recovery mode is refused.
The installer never chooses a fallback mode.

Staging records acknowledge earlier row installation. They do not assert that
current shared rows still equal the bundle or authorize activation. Later row
edits and local operations remain unchanged by image installation.

## Validate sources and commit destination protection

Every attempt reloads the complete published source bundle. It verifies all eight
saved payloads, their exact original catalog bindings, retained source protection
and physical image bytes. Invalid limits, missing source files or released source
protection refuse the attempt before a destination reservation is made.

The verified index supplies the full combined image manifest. This includes
history and invocation requirements, images from deselected runs and local source
requirements retained by that bundle. It can contain more images than the current
visible shared projection. Shared-only installation copies these required bytes
without copying source paths, uploads or pending filesystem records.

A stable destination recovery owner binds the original bundle descriptor, mode
and receiving identity. A reservation transaction validates staging metadata and
immutable image-name identities, then commits pending protection before any
image directory or file is created. Existing matching active protection can be
reused. Released owners cannot be reused, and incompatible metadata is refused.

Destination installation authority remains separate from this manifest owner.
The owner records protection rather than an installation receipt. Its state is
never sufficient proof that a particular destination root currently has the bytes.

## Publish exact bytes without overwriting evidence

The copy and final verification transaction holds the destination image writer
lock. Cleanup, release and other image writers cannot remove protection during
publication. Other connections continue to see the earlier committed pending pin
until retained protection commits.

Each image keeps its original immutable name. Missing files are written to
exclusive `.recovery-<bundle-sha256>-<filename>` temporary files, synced, linked
into place without overwriting an existing name and checked against their exact
length and SHA-256. Newly created directories are synced where supported.

Source bytes may be read from the existing readable archive when the live image
is absent. A matching destination live or archived file is verified and reused.
Corrupt live bytes are not hidden by an archive fallback. Conflicting archived
bytes, symlinks and unsafe directory components also refuse installation.

A matching final file is reusable only when the corresponding recovery temporary
file and local upload temporary file are absent. Temporary evidence is left for
review. The installer never deletes it automatically or overwrites conflicting
bytes. It does not replay taskspace filesystem callbacks.

After copying, the installer checks all required destination bytes under the
writer lock, confirms retained manifest protection and rechecks staging metadata
and required connection flags before commit. Source owners and earlier
protections are not released.

## Resume after interruption

The result includes `checkpoint`, `destinationIdentity`, `mode`, `owner`,
`manifest`, `copied`, `reused` and `changed`. The counters describe the verified
manifest requirements, not every file present in the source image directory.

A fully retained retry still reloads the source bundle and verifies destination
bytes. It returns `changed: false` when existing protection and files already
satisfy the request. Missing source evidence can still refuse that retry.

A failed reservation commit creates no destination image files or pins. A later
copy or final commit failure can leave valid published files while protection
remains pending. Those files stay protected from cleanup and can be reused on an
explicit retry. A failed final commit cannot return success.

A failed write, sync, link or temporary-file removal preserves interruption
evidence. Review that evidence before retrying. After a conflicting entry is
reviewed separately, a retry can reuse the other verified files. No attempt rolls
back published bytes by deleting or renaming them.

Owner protection remains active until explicitly released. Release after all
required retention obligations have transferred. Existing source protection and
retained history remain separate requirements. This step installs images only.
It does not install history, materialization bookkeeping or activate the workspace.

## Check staging metadata in a trusted host

`readRecoveryStagingDestination(tx, checkpoint, expected, destinationExpected, mode)`
and `inspectRecoveryStagingDestination(db, checkpoint, expected, destinationExpected, mode)`
are exported from `@kozane/core/recovery` with `RecoveryStagingDestination`.
They validate both host identities, canonical schema, complete migration history
and the required installation records. They refuse conflicting modes.

The transaction reader reuses a caller-owned read or write boundary. The inspector
opens one consistent read snapshot. Both return immutable metadata and perform
no filesystem work. They check neither current projection equality nor activation
readiness. The Node installer repeats this check inside its reservation and copy
transactions before trusting destination protection.
