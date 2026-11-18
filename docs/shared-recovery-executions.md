# Shared recovery executions

Core can prepare selected execution records beside shared row history.
Use the execution helpers from `@kozane/core/recovery` to preserve handler entry
order, resolved inputs, generated bindings and attribution for each row effect.
This preparation format does not define the production action-log schema.

## Prepare selected scope records

Obtain the original shared payload and its trusted descriptor. Read execution
records from completed scopes and supply independently retained expected counts.

```ts
const executions = await describeSharedRecoveryExecutions({
  checkpoint: shared.checkpoint,
  sharedHistory: shared.payload,
  selection: executionSelection,
  effectSets,
});
```

`selection` contains `baselineId` and an ordered `effectSets` array. Each selected
entry has `id`, `rootId` and `executionCount`. Its IDs must match the shared
checkpoint selection. Obtain root IDs and counts from trusted completed records
before receiving execution arrays. Deriving counts from the received arrays
cannot establish completeness.

Every effect-set record contains these fields.

| Field | Retained data |
| --- | --- |
| `id` | Selected effect-set identity |
| `invocation` | Root `id`, `kind`, `contractVersion` and JSON `input` |
| `generated` | Complete binding-provider snapshot for that root execution |
| `executions` | Actual root and child records, including children with no row effects |
| `effects` | One attribution record for each selected shared row effect |

Execution entries use `ActionExecutionRecord` fields. They include invocation
data, `parentId`, `executionOrd` and the bindings used by that frame. The root
must have ordinal zero, a NULL parent and the same invocation as the effect-set
record. Other entries require an already entered parent and its matching child-ID
binding. Every entry uses the root's contract version. Duplicate action IDs,
ordinal gaps and entry order that reopens a completed subtree are refused.

Each frame's binding must match the full provider snapshot. Bindings retain their
path keys, `entity-id`, `child-id` or `clock` type and exact value. Clock values
must be safe integers. Unused provider bindings remain present for skipped
replay branches. They are not reduced to the bindings used by selected frames.

Each attribution entry contains `ord`, `actionId` and `executionOrd`. Its ordinal
identifies the corresponding row effect in the bound shared history. Counts
must match the shared descriptor, and action IDs and execution ordinals must name
the same retained frame. Effects can return to active parents. They cannot
reenter a completed child or its closed ancestor. An action identity reused
across retained sets must keep its root, parent, kind and contract version.

Selected sets with no row effects still require a root execution and an explicit
positive expected count. A baseline-only checkpoint can have no selected sets.
Transported sets and execution entries can arrive out of order. Parsing restores
selection order and sorts entries by their retained ordinals.

## Bind execution contents

The result contains an immutable version 1 `payload` and content `checkpoint`.
The payload includes the original shared descriptor, expected roots and counts,
and every selected execution and attribution record. Description verifies the
source shared payload hash before returning.

The execution descriptor retains the same shared expectation and selection,
the canonical UTF-8 byte length and the SHA-256 digest of `JSON.stringify(payload)`
with no added newline. Changes to no-op child inputs, unused bindings or effect
attribution change this digest even when the shared row history is identical.

Invocation JSON is copied and frozen without calling getters or serialization
hooks. Object keys receive canonical ordering. Array order and string values
remain exact, including embedded JSON strings, NULs and leading byte-order
marks. Finite JSON numbers are retained, with negative zero normalized to zero.
Undefined values, cycles, sparse arrays and non-finite numbers are refused.
Each input and binding map uses the existing limits of 64 nested containers,
100,000 nodes and 8,388,608 UTF-16 string units.

Keep the descriptor independently from received payloads. Verify transport with
`requireSharedRecoveryExecutionCheckpoint(input, descriptor, expectedIdentity,
sharedHistory)`. It copies all inputs before hashing, checks the host's full
checkpoint identity and compares the original shared descriptor and expected
execution selection. It verifies the execution digest and the exact shared
payload hash before returning owned metadata.

`parseSharedRecoveryExecutionHistory` validates structure without establishing
authenticity. Lowering counts in a truncated received payload does not satisfy
an independently retained expectation. `parseSharedRecoveryExecutionCheckpoint`
accepts known historical schemas as metadata. Actual execution payloads require
the current bundled schema.

## Check invocation images

`sharedRecoveryExecutionAssetManifest(payload, historyImages)` checks each
effect-set manifest against the root invocation and every execution record.
It requires invocation-only references from no-op children and zero-effect sets.
Manifest IDs and order must match the execution selection.

The collector preserves all supplied manifest entries and refuses conflicting
immutable bytes under one name. Call it after verifying trusted execution
contents. Also use `sharedRecoveryAssetManifest` against the matching shared
payload to check baseline and full before and after image coverage. Neither
collector reads image bytes. The
[saved checkpoint image workflow](recovery-checkpoint-images.md) provides
protected byte verification for retained manifests.

## Retain trusted execution descriptors

Migration 0030 adds the device-local `local_recovery_executions` catalog.
`rememberSharedRecoveryExecutionCheckpoint(db, checkpoint)` registers the
descriptor established by trusted completed-scope capture. Register the original
local snapshot and shared row-history descriptors first. The execution descriptor
must name the same shared expectation, and both live source bindings must match.

Each catalog record retains the execution descriptor and the exact original
local snapshot descriptor. The transaction-bound variant shares a host-owned
commit. Registration acquires the writer lock before checking any binding.
Repeating the same pair preserves its timestamp. Changed hashes, lengths, root
IDs, expected counts or source bindings cannot replace it under the same key.

`readSharedRecoveryExecutionCheckpoint`,
`inspectSharedRecoveryExecutionCheckpoint` and
`parseSharedRecoveryExecutionCheckpointRecord` return an immutable `binding`.
Its `checkpoint` is the execution descriptor and `localCheckpoint` is the
original local expectation. The descriptor itself retains the original shared
checkpoint. Reads validate each pair and row identity without converting
registration timestamps to JavaScript dates.

Read and inspection helpers return `null` for an unregistered key.

The table has no foreign keys to shared rows or either source catalog. Orphaned
expectations therefore remain inspectable after a source descriptor disappears.
Inspection alone does not authorize verification or installation.

`requireStoredSharedRecoveryExecutionCheckpoint(catalog, input,
expectedIdentity, sharedHistory)` copies the received payload, expected identity
and source rows before its first read. It resolves the execution expectation and
both live source bindings in one read transaction. Hashing and attribution
validation run after that transaction closes. All three records are checked
again before the immutable payload is returned.

Missing or replaced records and changed original local bindings refuse success,
including a replacement of all three catalogs with another internally consistent
pair. Unrelated registrations and equivalent descriptor JSON formatting remain
allowed. Received catalog rows never establish their own trusted expectation.

Local snapshots include this eighth local table with exact tagged values.
Isolated local validation checks nested execution descriptors and their original
local bindings before allocating a database. Shared capture and replacement
exclude the catalog. JSON version 20 includes its records. Versions 7 through 19
import with an empty execution catalog when omitted. Import preserves coherent
historical and orphaned metadata without installing execution records or images.

Registration stores expectations rather than payload bytes. It does not save
execution arrays, image manifests or image files. Catalog-backed verification
checks content and attribution, with no SQL validation or live installation.

## Current scope

These helpers preserve selected finalized scope data. They do not invoke
handlers, reinterpret old envelopes or require support for the recorded action
contract. Unknown kinds and positive contract versions remain data for exact
restoration and audit. Trusted capture establishes causal attribution and shared
eligibility. Structural verification provides neither authorization.

Core can prepare [original action records](shared-recovery-actions.md) with first
inputs, binding maps, exact local sequence values and provenance. These records
remain distinct from later execution inputs. Durable original-record storage,
origin and deselected execution sets and retention policy remain requirements
for complete history.
The Node host can retain [saved execution payloads](shared-recovery-execution-payloads.md)
with both saved sources and all three original catalog bindings. The
[saved asset workflow](recovery-asset-payloads.md#check-saved-execution-coverage)
can check invocation image coverage and carry all four original expectations
through image reservation and verification. Complete bundle publication and
installation remain pending. Production capture remains subject to the
[adapter verification gate](action-capture-prototype.md).
