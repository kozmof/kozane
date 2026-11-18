# Original recovery actions

Core can prepare first-recorded actions beside selected execution history.
Use the action helpers from `@kozane/core/recovery` to preserve original inputs,
bindings, local record order and provenance when later executions change child
arguments or skip children. This preparation format does not define the
production action-log schema.

## Prepare original records

Obtain the trusted [execution checkpoint](shared-recovery-executions.md), its
payload and the matching shared row history. Supply the retained original
records and an independently established action selection.

```ts
const originals = await describeSharedRecoveryActions({
  actions: firstRecordedActions,
  selection: originalActionSelection,
  checkpoint: executions.checkpoint,
  executions: executions.payload,
  sharedHistory: shared.payload,
});
```

`selection.actionIds` lists the required original records in local first-record
sequence order. Establish this list from trusted retained history before
receiving action arrays. Deriving it from received arrays cannot establish
completeness. Transported arrays can arrive out of order. Parsing restores the
trusted selection order and requires strictly increasing sequence values.

Each `SharedRecoveryActionRecord` contains these fields.

| Fields | Retained data |
| --- | --- |
| `id`, `rootId`, `parentId` | Original action identity and tree |
| `kind`, `contractVersion`, `input` | First recorded invocation |
| `generated` | Complete root provider snapshot or original child frame bindings |
| `seq` | Positive signed SQLite INTEGER as a canonical decimal string |
| `hlc`, `deviceId`, `epochId`, `schemaId` | Recorded provenance |

Keep `seq` as a string, including values beyond JavaScript's safe integer range.
Values range from `"1"` through `"9223372036854775807"`. Gaps are allowed.
Duplicate values, leading zeros, whitespace, numeric coercion and values outside
that range are refused. This order describes first recording on the retained
device database. It does not replace execution entry order or row-effect order.

Every selected root requires its original record with a NULL parent and a
self-reference through `rootId`. A child requires an earlier retained parent in
the same root group and a child-ID allocation in the full root binding map.
Original child bindings must match entries in that map. Contract versions agree
within each group. Epoch and schema identities must match the checkpoint.

The recorded `deviceId` can differ from the checkpoint's device. `hlc` is opaque
metadata. These helpers preserve it without defining a clock format, clock
assignment or synchronization ordering policy.

Include original records for children that no longer execute in the selected
sets. Every supplied record must belong to a selected root and appear in the
trusted action selection. A baseline-only checkpoint can have an empty action
selection.

## Check later executions

Description verifies both the original execution descriptor and its shared
payload hash. Every selected execution must name a retained original action
with the same root, parent, kind and contract version. The original root input
and complete provider snapshot must match every selected set for that root.
Changes to unused provider bindings are refused too.

Child inputs and used binding subsets can differ in later executions. Their
first-recorded inputs remain in the original action records. A skipped child
needs no execution entry in a later set. The original child record remains
retained for audit and recovery.

Unknown kinds and positive contract versions remain data. These helpers invoke
no action handlers and do not reinterpret old invocation envelopes. Trusted
capture establishes causal attribution and eligibility. Structural checks do
not establish either.

## Bind original contents

The result contains an immutable version 1 `payload` and content `checkpoint`.
The payload includes the exact execution descriptor, trusted action selection
and every original record. Its checkpoint retains that same binding and
selection, the canonical UTF-8 byte length and SHA-256 hash of
`JSON.stringify(payload)` with no added newline.

Retain the checkpoint independently from received payloads. Verify transport
with `requireSharedRecoveryActionCheckpoint(input, checkpoint, expectedIdentity,
executions, sharedHistory)`. Verification copies all inputs before hashing and
checks the host's full checkpoint identity, original selections and all three
content hashes. Changed provenance, skipped-child inputs and unused bindings
change the original payload hash even if the selected executions are unchanged.

`parseSharedRecoveryActionHistory` performs structural parsing without
authentication. Reducing a received action list and selection does not satisfy
an independently retained expectation. `parseSharedRecoveryActionCheckpoint`
accepts known historical schemas as metadata. Actual action payloads require
the current bundled schema.

Invocation JSON and binding maps use the same strict ownership and input limits
as [execution payloads](shared-recovery-executions.md#bind-execution-contents).
Strings retain their exact values. Parsing calls no getters or serialization
hooks and refuses sparse arrays, cycles, undefined values and non-finite numbers.

## Check original invocation images

Call `sharedRecoveryActionAssetManifest(payload, images)` after verifying the
original payload. Supply an image manifest that covers every original input,
including children skipped by selected executions. The collector preserves
extra supplied requirements and refuses missing original references or
conflicting immutable names. It reads no image bytes.

Original inputs can reference images absent from both later execution inputs
and shared rows. Supply `actionMaxBytes` with `executionMaxBytes` to the
[saved asset workflow](recovery-asset-payloads.md#check-saved-original-actions)
to check original input coverage alongside current execution coverage. The
[saved checkpoint image workflow](recovery-checkpoint-images.md#check-saved-original-invocation-images)
can then reserve and verify those combined requirements. Keep earlier image pins
until its reservation commits.

## Retain trusted action descriptors

Migration 0031 adds the device-local `local_recovery_actions` catalog.
Register the original local, shared and execution expectations first. Then call
`rememberSharedRecoveryActionCheckpoint(db, checkpoint)` with a descriptor
established by trusted first-record capture. Received catalog rows do not
establish that trust.

Each record retains the action descriptor and exact original local descriptor.
The action descriptor itself binds the original execution and shared
expectations. Registration acquires the writer lock and requires all three live
source catalogs to match. Changed contents, action selections or source bindings
cannot replace an existing key. Repeating the same binding preserves its
timestamp. `rememberSharedRecoveryActionCheckpointInTx` shares a host-owned
commit with dependent work.

`readSharedRecoveryActionCheckpoint`, `inspectSharedRecoveryActionCheckpoint`
and `parseSharedRecoveryActionCheckpointRecord` return an immutable `binding`.
Its `checkpoint` is the action descriptor and `localCheckpoint` is the original
local expectation. Reads check row identities and nested descriptor coherence
without converting registration timestamps to JavaScript dates. Read and
inspection helpers return `null` for an unregistered key.

The catalog has no foreign keys to shared rows or other catalogs. Historical
and orphaned expectations remain inspectable after source records disappear.
Inspection does not authorize verification or installation.

`requireStoredSharedRecoveryActionCheckpoint(catalog, input, expectedIdentity,
executions, sharedHistory)` copies all transport and the host identity before
its first catalog read. It resolves all four original bindings in one read
transaction. Content and attribution checks run outside that transaction.
All four catalogs are checked again before success, including the original
local bindings retained by the execution and shared records. Coherent replacement
of every catalog with another binding still refuses success. Unrelated
registrations and equivalent descriptor JSON formatting remain allowed.

Local snapshots include this ninth local table with exact tagged values.
Isolated local validation checks every nested action descriptor before database
allocation. Shared capture and replacement exclude the table. JSON version 22
includes its records. Versions 7 through 20 import with an empty action catalog
when omitted. Import preserves coherent historical and orphaned metadata without
installing original action records or reading images.

Registration stores expectations. The Node host can retain
[saved original-action payloads](shared-recovery-action-payloads.md) after
validating their saved sources and all four original catalog bindings.
Manifests and image bytes remain separate requirements.

## Current scope

These helpers prepare original records for roots named by the selected execution
checkpoint. Preparation and content checks perform no SQL validation, file
writes, image reservation or live installation.

[Retained recovery history](shared-recovery-retained-history.md) prepares origin,
superseded rebase and authoritative runs for the same selected roots. Durable
complete history retention and bundle publication remain pending. Production
capture remains subject to the
[adapter verification gate](action-capture-prototype.md).
