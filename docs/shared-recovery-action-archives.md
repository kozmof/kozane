# Recovery action archives

Action archives preserve first-recorded actions for roots outside the current
materialization. They also keep the current originals unchanged. Use the archive
helpers from `@kozane/core/recovery` to prepare and verify these records without
selecting runs or invoking handlers.

## Establish the inventory

Supply a separately trusted `SharedRecoveryActionArchiveSelection` with ordered
`rootIds` and `actionIds`. Include every current original action and every root
named by the current execution checkpoint. Additional roots and skipped children
may be present. Action IDs must follow unique first-record sequence order.
Root IDs must follow their positions in that action inventory.

Use the [current original-action descriptor](shared-recovery-actions.md) as
`checkpoint`. Keep its payload and the matching selected execution and shared
payloads as source evidence. Every current original record must remain exactly
equal in the archive, including its input, bindings, sequence and provenance.

Prepare an archive from the trusted inventory and complete original records.

```ts
const archived = await describeSharedRecoveryActionArchive({
  checkpoint: originals.checkpoint,
  selection: { rootIds, actionIds },
  actions,
  originals: originals.payload,
  executions: executions.payload,
  sharedHistory: shared.payload,
});
```

The result has an immutable `payload` and `checkpoint`. The descriptor binds the
current original-action expectation, full archive inventory, canonical UTF-8 byte
length and SHA-256 hash. Preserve it independently of the payload. Payload claims
alone cannot establish the completeness or authenticity of the inventory.

Records use `SharedRecoveryActionRecord`. Each root must retain its complete
provider map. A child requires an earlier parent in the same root and a retained
child-ID binding. Its used bindings must match the root provider. Every action
under one root keeps the root's contract version. Root contracts may differ,
and unknown kinds and positive versions remain data.

First-record sequences remain canonical positive SQLite INTEGER strings, up to
`9223372036854775807`. Opaque clock metadata, device provenance, embedded NULs,
Unicode text and skipped inputs remain exact. All records use the host
checkpoint's epoch and bundled schema. Device provenance may differ between
records and does not establish authority or synchronization status.

A current baseline with no selected actions may still have a nonempty archive.
Adding archived roots does not select their runs, change the materialization or
classify them as accepted, rejected or pending work.

## Verify the archive

Call `requireSharedRecoveryActionArchiveCheckpoint(input, checkpoint,
expectedIdentity, sources)` with an independently trusted archive expectation.
`SharedRecoveryActionArchiveSources` contains `originals`, `executions` and
`sharedHistory` payloads.

Verification owns all metadata and sources before hashing. It requires the full
host identity, exact inventory and original descriptor, unchanged current
original records, canonical archive contents and all three current source
hashes. Removed roots, truncated actions and changed metadata cause failure even
when the current materialization is unchanged.

`parseSharedRecoveryActionArchive` checks structure and first-record relations
without establishing authenticity. Transport action order is canonicalized to
the trusted action inventory. Inventory order itself is preserved.
`parseSharedRecoveryActionArchiveCheckpoint` permits known historical source
descriptors as metadata. Actual archive records require the bundled schema.

## Collect image requirements

`sharedRecoveryActionArchiveAssetManifest(input, images)` requires image metadata
for every archived original input, including unselected roots, nested children
and skipped actions. It preserves extra host requirements. Missing entries and
conflicting duplicate identities cause failure during manifest parsing or
coverage checks.

This collector checks metadata without reading bytes or reserving images.
Baseline, full effect and resolved execution images remain separate requirements.

## Current scope

Archives prepare first-recorded actions for additional roots. They do not retain
those roots' executions or effects, store trusted catalog records or payload
files, install rows or publish complete bundles. Existing saved original and
retained-history formats still cover roots in the current selected checkpoint.
Connecting broader archives to durable history retention, manifests and image
protection remains pending. Production capture remains subject to the
[adapter verification gate](action-capture-prototype.md).
