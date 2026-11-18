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
and shared rows. The existing saved checkpoint workflow's `executionMaxBytes`
checks selected execution inputs. It does not cover these additional original
records. Retain their manifests and earlier image pins separately until a
durable workflow protects the combined requirements.

## Current scope

These helpers prepare original records for roots named by the selected execution
checkpoint. They perform no SQL validation, catalog registration, file writes,
image reservation or live installation.

Durable original-record storage, saved manifest integration, origin and
deselected effect sets, complete history retention and complete bundle
publication remain pending. Production capture remains subject to the
[adapter verification gate](action-capture-prototype.md).
