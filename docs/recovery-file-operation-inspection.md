# Inspect staged recovery file operations

Recovery inspection reports current pending filesystem evidence after a complete
local snapshot has been staged. It reads journal rows and optional disk evidence
without confirming operations or repeating filesystem work.

## Inspect an installed local snapshot

Use `inspectStagedRecoveryFileOperations` from
`lib/server/recovery-file-operations.ts` after
[local installation](local-recovery-installation.md). Supply the staged database,
the independently trusted originating identity, the original bundle descriptor
and the workspace root to inspect.

```ts
const report = await inspectStagedRecoveryFileOperations({
  db: destination,
  root: workspaceRoot,
  checkpoint: bundleCheckpoint,
  expected,
  limit: 25,
  offset: 0,
});
```

The database must have the exact canonical schema, complete migration history
and a local installation record matching the supplied bundle and host identity.
Temporary schema objects are refused. A fresh database or a shared-only
installation does not authorize inspection of source-device local paths.

Inspection works before or after shared projection staging. Taskspaces or
namespaces referenced by pending records may be absent. No source bundle files or
validation databases are needed once the matching local installation exists.

## Read current evidence without replay

The result includes the original `checkpoint`, exact decimal-string `total`,
`limit`, `offset`, tagged `operations`, `nextOffset` and `observations`. Only rows
whose current state is `pending` appear. Confirmed and abandoned rows stay out of
the report. Later journal edits are inspected as current evidence rather than
replaced with the original snapshot.

Records retain every journal column, including original intent bytes, retained
errors and timestamps. The tagged codec preserves full integers, storage
classes, Unicode and embedded NUL characters. Timestamps are not converted to
JavaScript dates. This also preserves pending records with values outside the
JavaScript date range or unusual SQLite storage classes.

Each observation contains its exact `record` and one observation label. Supported
version 1 records reuse the existing read-only observers.

| Kind | Reported evidence |
| --- | --- |
| `taskspace.claim` | Directory presence and exact marker-hash agreement |
| `taskspace.file` | Current entry presence, content-hash agreement or rename endpoint presence |
| `taskspace.directory` | Managed directory and marker identity at the recorded source, intermediate and destination paths |

Malformed intents retain their original bytes and report `invalid-intent`.
Unsupported field storage classes report `unsupported-record`. Unsafe paths and
unreadable evidence retain the existing observer's diagnostic labels. Absolute
paths report `absolute-path-not-inspected` by default. Set
`allowAbsolutePaths: true` explicitly when the trusted host intends to inspect
those originating-device paths.

Matching marker or content bytes describe a current observation. They do not
prove which process performed the work or authorize confirmation. Recorded errors
remain intact even when current disk evidence matches. Inspection creates no
attachments, shared rows, journal updates or files and runs no mutation callback.

## Bound a report and detect concurrent changes

The default page contains up to 25 rows. `limit` must be an integer from 1 to 100.
`offset` must be a safe nonnegative integer. Rows use journal-ID order rather than
converting or sorting creation timestamps in JavaScript. The pending count and
page rows are captured in one consistent read transaction.

Use `nextOffset` to request another page. It is `null` when that snapshot has no
more rows. Totals remain exact integer text. An offset that would exceed the
supported numeric range refuses the report.

Pages are independent diagnostics. Concurrent journal edits can move rows
between pages, so offset pagination is not a stable export cursor. Use an exact
local snapshot when a complete consistent journal export is needed.

Disk observations run after the database read closes. The host then reads the
same page and count again. If its journal evidence or installation binding
changed, it refuses the report. Read-boundary failures also refuse success.
Files can change independently, so observations remain point-in-time diagnostics.

## Use the core metadata reader

Import these helpers and types from `@kozane/core/recovery`.

- `inspectPendingRecoveryFileOperations(db, checkpoint, expected, options)` opens one consistent read snapshot and returns exact current pending evidence.
- `readPendingRecoveryFileOperations(tx, checkpoint, expected, options)` reuses a caller-owned read or write transaction.
- `PendingRecoveryFileOperationOptions` defines optional `limit` and `offset` fields.
- `PendingRecoveryFileOperationPage` defines the immutable checkpoint, tagged records, exact total and pagination result.

The core reader performs no filesystem reads. The Node observer uses this reader
before and after disk inspection. Neither helper activates the workspace or
confirms an operation. Full recovery still requires retained history,
bookkeeping, destination images and activation. Applying reviewed filesystem
recovery remains separate from this staged inspection API.
