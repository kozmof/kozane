# Capture local rows and selected shared history together

`captureRecoveryCheckpoint` captures a matching local snapshot and complete
selected shared history from one consistent database read transaction. It checks
that the history reconstructs the live shared rows before returning either
content descriptor.

Import the helper and its result types from `@kozane/core/recovery`.

```ts
import { captureRecoveryCheckpoint } from "@kozane/core/recovery";

const captured = await captureRecoveryCheckpoint(
  db,
  expectedIdentity,
  readCompletedHistory,
);
```

## Supply a trusted history reader

The host establishes the workspace, device, epoch, checkpoint and current bundled
schema identity independently. The helper owns those values before asynchronous
work. It does not allocate durable identities.

`readCompletedHistory(tx)` is a host-owned function. It returns a
`RecoveryCheckpointHistory` object containing `history` and `selection`.
Read the baseline, selected complete effect sets, materialization order and
trusted effect counts through the supplied `ReadTx`. The selection uses the
existing `SharedRecoverySelection` format. The history uses the existing complete
baseline and full row-effect format.

The facade exposes reader methods. Raw SQL remains trusted, so the callback must
issue only reads. Keep every source read inside this boundary. Avoid cached
selections, separate connections and another `withReadTx` call in the reader.
The host remains responsible for identifying completed retained records and
preserving their history and assets until bundle publication finishes.

## Verify one consistent source state

Before invoking the reader, capture requires canonical managed tables, indexes
and triggers and complete bundled migration history. Independent host history
tables may coexist with those objects. Altered managed objects and temporary
schema objects are refused.

The helper owns and reconstructs the supplied history, checking expected counts,
materialization order, consecutive effect ordinals and full before images.
It derives the local snapshot's baseline and ordered effect-set IDs from that
same selection, then reads all fourteen portable local tables. Empty tables,
absent taskspace metadata and pending operations remain present in the snapshot.

Exact tagged read-back compares every current shared row with the reconstruction.
Missing or extra rows, different storage classes, unsafe integer differences and
changed REAL bits refuse capture. The source history must reconstruct the exact
current rows.

Identity, reader-result, schema, history and live-row errors refuse capture before
hashing. A failed reader or adapter read completion cannot return a checkpoint.
The helper performs no source writes or filesystem work.

## Retain the existing payloads and descriptors

The immutable `CapturedRecoveryCheckpoint` result contains two existing shapes.

| Field | Contents |
| --- | --- |
| `local` | Local `snapshot` and its `checkpoint` descriptor |
| `shared` | Shared history `payload`, reconstructed `projection` and its `checkpoint` descriptor |

Both hashes start after the adapter read transaction and cleanup complete.
Later writes cannot change the owned inputs. Native concurrency tests verify that
a competing commit cannot mix newer local rows with older history or vice versa.

Register the trusted pair through the existing catalogs after capture succeeds.
Preserve the original payloads separately.

```ts
await rememberLocalRecoveryCheckpoint(db, captured.local.checkpoint);
await rememberSharedRecoveryCheckpoint(db, captured.shared.checkpoint);
```

The local snapshot excludes its own later registration. Existing descriptor
versions, canonical byte formats, portable table inventory and JSON export
version remain unchanged. The result supplies no publication, installation or
activation receipt.

Continue with [saved local payloads](local-recovery-payloads.md),
[saved shared history](shared-recovery-payloads.md) and their later bundle steps.
This capture API does not publish a bundle, reserve images, install rows, replay
pending file operations or activate a workspace. Production capture integration
and browser runtime verification remain pending.
