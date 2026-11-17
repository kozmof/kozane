# Saved local snapshot payloads

The Node host can save an original registered snapshot as an immutable file.
`saveRegisteredLocalRecoveryPayload` in `lib/server/local-recovery-payload.ts`
requires the trusted catalog, the original snapshot, the host's expected identity
and a separate validation database factory. It performs catalog-backed hash and
SQL validation before creating payload directories.

Use the public `@kozane/core/recovery` entry to capture and register the trusted
descriptor first. Keep the original payload for retries. Recapturing the live
database is a new checkpoint, since catalog registration itself changes local
data. See [local recovery snapshots](local-recovery-snapshots.md).

## Publish a saved payload

Files live under `.kozane/recovery/checkpoints`. A published filename is the
descriptor's lowercase SHA-256 digest followed by `.json`. Its temporary name is
`.pending-<digest>.json`. Snapshot identities never become path components.

The host takes the catalog writer lock and rechecks the trusted binding before
disk work. It creates a temporary file exclusively with mode `0600`, writes the
canonical UTF-8 JSON and syncs the file. It verifies length, digest and file
identity, then publishes through an exclusive hard link, removes the temporary
name and syncs the directory. The host skips directory sync on Windows. The file
itself is always synced.

Existing matching published bytes are verified and left unchanged. Different
bytes, non-regular files, symbolic links and unsafe parent directories refuse
publication. Temporary evidence also refuses another save attempt, including a
complete matching temporary file. There is no automatic retry or replacement.

The original catalog record remains committed before every filesystem write.
Failures preserve that descriptor and any temporary or published files. A failed
outer transaction can leave verified published bytes even though the call
rejected. Inspection can report that evidence, and an explicit retry with the
original payload can verify an already published file without rewriting it.

## Inspect interrupted work

`inspectRegisteredLocalRecoveryPayload` reads the registered descriptor and
observes both filenames. It reports absent, matching, different, unsafe or
unreadable content. Reads are bounded by the registered length and use a fixed
buffer. File identity and modification metadata are checked before returning a
match. Symbolic links and non-regular entries are not followed.

Inspection creates no directories, writes no records and never publishes or
removes temporary data. Matching content is evidence about the observed bytes,
not an installation receipt or permission to repeat filesystem changes.

Node tests cover committed intent before publication, canonical bytes,
idempotency, partial writes, sync and link failures, temporary unlink failure,
unsafe paths, competing catalog removal and failed outer commits.

## Read a saved payload

Call `loadRegisteredLocalRecoveryPayload` with the root, trusted catalog database,
host's expected identity, `maxBytes` and a separate validation database factory.
The size limit must be a positive safe integer. The reader rejects a registered
length above that limit before opening a file or allocating its byte buffer.
The limit bounds input bytes, while JSON parsing and validation need additional
memory.

The reader accepts only the published file. Any temporary entry requires review,
even when its bytes match the descriptor. Missing files, unsafe paths, different
bytes and files that change while being read refuse loading. Strict UTF-8
decoding and canonical JSON hash checks precede isolated SQL validation. Exact
tagged read-back verifies that SQL storage preserves the snapshot values.

Catalog binding checks surround the file read and run again before returning.
The final check also verifies that the published file's identity, length and
modification metadata still match. Canonical snapshot validation runs outside
these catalog writer boundaries, so unrelated checkpoint registration can
continue. Changed bindings, replaced or rewritten files and new temporary data
refuse success.

The result contains the immutable snapshot and trusted descriptor. Reading
creates no directories and does not alter or remove files. Temporary validation
rows are rolled back. The result provides no installation receipt or destination
activation. Installation still needs a durable boundary that rechecks its
requirements.

## Protect checkpoint images

`reserveRegisteredLocalRecoveryImages` in `lib/server/local-recovery-images.ts`
combines the bounded payload reader with the local manifest ledger. Supply the
reader's inputs and a `history` object containing a baseline and an ordered
`effectSets` list. Each history entry has an `id` and an image `manifest`. Obtain
these manifests from complete retained history records and keep their earlier
pins until the reservation commits.

The helper copies history metadata before reading the saved payload. It checks
the baseline and ordered effect-set IDs against the trusted checkpoint selection.
It combines their manifests with required local snapshot images and checks
immutable names against active and inactive identity records. Matching IDs do
not prove that history records are complete. The host must establish that before
calling this helper.

The helper derives a recovery owner from the workspace, device, epoch and
checkpoint key. It rechecks the catalog binding under the image writer lock and
commits a pending reservation without reading image bytes. Repeating the same
reservation preserves its timestamps. Changed image requirements cannot replace
the owner's manifest. `registeredLocalRecoveryImageOwner` returns this stable
owner for inspection through the ledger APIs.

`retainRegisteredLocalRecoveryImages` prepares the same requirements and commits
the reservation before verifying files in a separate writer transaction. It
accepts matching live or archived image bytes and rechecks the catalog binding
before success. Missing, unsafe or changed bytes refuse verification while
leaving the earlier protection committed. New owners remain pending after failed
verification or commit. Previously retained owners keep their earlier
verification record and protection after a failed recheck. Neither helper
installs files or releases earlier owners.

Both pending and retained reservations protect images during cleanup. Retire
the owner only through the ledger's explicit release API and a retention decision
that no longer requires the checkpoint. Released owner IDs cannot be reused.
Verification always checks bytes again, including retries of a retained owner.

These helpers protect image requirements. They do not retain baseline or
effect-set files, establish their completeness, copy image bytes into a bundle
or publish a complete bundle. Later publication must verify those requirements
and the saved payload under its own durable boundary.

Matching [shared row-history payloads](shared-recovery-payloads.md) use a separate
directory and the same immutable file protocol. Their host workflow also checks
the original local descriptor retained in the shared catalog.

When both payloads are saved, use the
[saved checkpoint image workflow](recovery-checkpoint-images.md) to check
manifests against actual shared rows as well as selected IDs. It checks both
saved files and catalog bindings around protected image verification.

[Saved asset manifests](recovery-asset-payloads.md) retain canonical requirements
bound to both original payload descriptors. Their separate publication and
bounded reads validate both source files. The image workflow still receives
host manifests directly.

## Current scope

This file stores only the local snapshot payload. It does not contain shared
baseline or action history files, image bytes, taskspace file contents or config.
Saving it alone does not pin images or retain history. The separate image
workflow protects required local bytes. A complete bundle still needs retained
history and a durable publication boundary. One-time installation,
destination activation, payload retention policy and end-user recovery commands
remain pending. Startup does not retry these writes.
