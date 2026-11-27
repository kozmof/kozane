# Local filesystem operation records

Migration `0021_local_file_operation` adds a device-local journal. Its first
supported operation is `taskspace.claim`, version 1, used by HTTP and CLI taskspace
creation. Migration `0022_taskspace_file_operations` adds `taskspace.file`, version
1, for the five file mutation methods. Migration `0023_taskspace_directory_operations`
adds `taskspace.directory`, version 1, for managed directory removal and the legacy
combined rename endpoint. Migration `0024_local_operation_abandonment` adds durable
abandonment metadata. CLI layout moves now use directory intents that include
all planned paths.

After a complete local recovery snapshot has been staged, use
[staged inspection](recovery-file-operation-inspection.md) to read exact current
pending evidence and bounded disk observations. This path requires the matching
installation record and trusted originating identity. It performs no confirmation
or filesystem replay.

Creation uses three phases:

1. A database transaction creates the shared taskspace and a pending operation.
   It records the namespace and taskspace IDs, stored path and path kind, claim
   options and SHA-256 hashes of the intended marker bytes. It creates no local
   attachment. CLI creation still permits a taskspace without a scope.
2. After that transaction commits, the host claims the directory and writes the
   marker once. It does not hold a database transaction open during filesystem
   work. Marker ownership depends on whether this call created the directory;
   when adoption permits either outcome, the intent records both possible hashes.
3. A second transaction publishes the local attachment and confirms the operation
   together. Local observations preserve the shared taskspace timestamps.

A failure before the first commit touches no disk. If the directory claim fails,
the host attempts to remove the new shared identity and record the error in one
transaction. The pending operation survives compensation, including when its
taskspace or namespace no longer exists. If compensation also fails, the caller
receives both errors and the original pending intent remains.

Creation copies record and directory inputs before awaiting database work.
Initial publication and the check before disk work require the original shared
record, exact pending intent and no local metadata. Compensation deletes only an
unchanged shared record without local metadata or linked cards. Later shared
edits, attachments, card links or separately recorded errors block compensation.
Its error record and final shared-row absence are verified after database triggers.

If attachment or confirmation fails after the marker was written, the host keeps
the directory, shared identity and pending operation. It rolls back attachment
changes. The caller receives a recovery message rather than success. A process
interruption at either durable boundary likewise leaves a pending operation.

Creation confirmation requires the intended marker bytes through a path without
symbolic links. It verifies the final journal receipt, original shared fields,
attachment, observation and marker after database triggers finish. Changed
evidence rolls back attachment publication. HTTP and CLI creation direct callers
to `doctor` when confirmation or compensation needs recovery.

Attach a directory to an existing shared taskspace with an explicit path.

```sh
kozane taskspace attach <taskspaceId> --dir ./notes
```

The taskspace must already belong to a namespace and have no directory attachment
or pending local work. An existing directory must have no marker. Symlinks are
refused. The command records the same version 1 claim intent before disk work and
confirms the local attachment afterward. It preserves all shared fields and never
deletes the shared identity after failure. A user-chosen directory remains
user-owned even when the command creates it. Interrupted attachment uses the
claim recovery flow below, which never repeats directory creation.

Existing-taskspace attachment rechecks the namespace, exact attachment path and
kind, local observation and marker after confirmation triggers finish. Changed
publication rolls back the attachment and journal confirmation together. The
completed directory claim and pending intent remain available for recovery.

File mutations, managed directory operations, layout moves and attachment to an
existing taskspace share a journal boundary. It copies intent fields before
asynchronous preparation and verifies the pending row after insertion, before
filesystem work and before database publication. Confirmation and error recording
check the final journal row after database triggers finish. Changed identity,
creation time or evidence rolls back publication or error recording. A separately
committed error stays intact when later error recording fails, and the caller
receives both failures. Completed disk work is never repeated by this boundary.

`kozane doctor` reports the pending count and up to five operation IDs with disk
observations. It distinguishes missing directories, missing markers, exact marker
hash matches, different markers, unsafe paths, invalid intent and unreadable
evidence. Inspection refuses symlinks and never changes the operation or directory.
A matching marker alone does not confirm an operation. `doctor --fix` does not
confirm or retry directory claims. On the first authenticated request for an
opened database, the server reports pending claims once per database handle and
workspace. Static prerendering skips this check. Inspection failures produce a
diagnostic without blocking service. Startup never attaches directories or
repeats filesystem callbacks.

Inspect a claim with the full operation ID printed by `doctor`.

```sh
kozane taskspace recover <operationId>
kozane taskspace recover <operationId> --apply
```

The default is read-only. Applying repeats verification inside the database write
transaction and serializes with this process's taskspace operations. It requires
the exact marker bytes, hashes derived from the recorded identity and claim
options, an existing taskspace in the original namespace and an absent or
matching attachment. A different attachment, a missing shared identity or unsafe
disk evidence blocks confirmation. The command does not recreate shared rows.

Confirmation commits the attachment, current local observation time and journal
completion together. It preserves shared timestamps and changes no files.
Statement and commit failures retain the pending operation and prior attachment.
Confirmation matches the inspected claim identity, creation time and recorded
error, then checks the final journal receipt, namespace and attachment after
database triggers finish. Changed evidence rolls back local publication and
confirmation together. Eligibility reads leave shared timestamps and prior local
observation timestamps opaque, including integers outside JavaScript's safe range.
Repeating confirmation of an already confirmed operation makes no changes.
Blocked claims remain available for manual recovery. Explicit abandonment records
an operator's reviewed decision without claiming that the filesystem work completed.

The five file mutations use the same pending and confirmed states. File creation,
saves, directory creation, entry renames and entry removal commit their local
intent before invoking filesystem work. The intent records the actual affected
path, operation and requested path. Renames include their destination. File
creation and saves include a SHA-256 hash of the intended bytes. Saves also retain
the caller's signature. File contents are not stored in the journal.

Each mutation remains inside the taskspace queue through confirmation. The host
rechecks visibility, attachment and resolved path after the intent commits. It
then invokes the filesystem callback once and waits for it to settle before
confirming completion. Shared application rows and local attachments are unchanged.

Callback failures retain pending intent and attempt to record the error. If error
recording fails too, both failures are reported. A failed confirmation leaves disk
as the callback left it and keeps the operation pending. The HTTP response directs
the caller to `doctor` before repeating the change. There is no compensating file
write, rename or deletion after publication.

`doctor` and authenticated server startup inspect pending file operations without
changing them. File hashes distinguish matching bytes from changed content.
Directory creation reports whether a directory is present. Rename inspection
reports source and destination presence. Removal inspection reports entry
presence. These observations do not prove which process changed a file and do not
confirm an operation. `doctor --fix` does not retry file work.

`taskspace recover <operationId>` previews file outcomes without changing files or
database rows. It requires an existing taskspace visible in the recorded namespace
and an existing namespace. The requested path must resolve through the current
attachment to the exact recorded affected path and path kind. Unsafe paths,
symbolic links and malformed intents block confirmation. Existing absolute
attachments are supported under the same checks.

Each operation requires its recorded outcome.

| Operation | Required disk state |
| --- | --- |
| Create or save a file | Regular file with the exact intended content hash |
| Create a directory | Directory at the recorded path |
| Rename an entry | Destination present and source absent |
| Remove an entry | Recorded entry absent |

Review disk state before applying confirmation. These observations establish the
current outcome, not which process produced it. Version 1 file intents do not
retain entry identity or directory contents. A recorded filesystem error may
describe partial work and blocks confirmation even when disk state now matches.
Inspect and repair that work manually, then abandon reviewed tracking.

`--apply` rechecks visibility, attachment and disk state inside a write transaction
after acquiring the taskspace queue. It confirms only the journal entry. Files,
shared rows, attachments and observation timestamps remain unchanged. A failed
statement or commit retains pending evidence. Repeated confirmation is idempotent.
Abandoned operations cannot be confirmed. Startup and `doctor` only report evidence
and never apply confirmation automatically.

File mutation confirmation and explicit recovery share the same outcome checks.
Before committing, the host verifies the final journal receipt and rechecks
visibility, attachment and disk state after database triggers finish.
Changed evidence rolls back confirmation. A newer file edit stays on disk.
Eligibility checks read only namespace and path fields, so large shared timestamps
and prior local observation timestamps remain unchanged without JavaScript number
conversion.

File mutations copy their request and path resolver before asynchronous journal
work. A separately committed attachment change stays intact when final verification
refuses confirmation. The host reports that recovery is needed and keeps pending
evidence without repeating file callbacks.

Managed directory removal and legacy combined rename commit intent before changing
disk. Their intent retains the original shared fields and attachment, the exact
marker hash and directory device and inode IDs. Moves also record the new label
and destination. Device and inode IDs are decimal strings so identity checks
preserve their full values.

The host rechecks shared fields, attachment, management rules, directory identity
and marker before invoking the filesystem callback. It repeats shared record and
attachment checks in the final transaction. That transaction commits shared
deletion or label changes, any attachment update and journal confirmation together.
A concurrent edit prevents the final transaction from overwriting newer state.
Local observation timestamps remain unchanged.

Legacy HTTP rename and removal read shared fields and attachment paths without
decoding local observations. Directory nesting checks read only taskspace IDs and
paths, so unrelated shared timestamps also stay opaque. Database context and
routing are captured before waiting for other taskspace work. Version 1 directory
intents still require representable shared timestamps for the taskspace being
moved or removed.

If the final transaction fails, the completed move or removal remains on disk and
the intent stays pending. The legacy rename endpoint no longer moves a directory
back automatically after a database failure. Partial deletion retains the marker
when the existing filesystem helper can do so. A matching marker does not prove
that all original contents survived a partial deletion.

`doctor` and authenticated startup inspect pending directory operations without
changing them. Inspection reports source and destination presence, marker and
directory identity mismatches, unsafe paths and unreadable evidence. Database-only
changes that keep or already lack a directory do not create a directory journal entry.

CLI layout repair records the source and destination before its first move. When
the destination is inside the source, the intent also records the temporary path.
Each step checks the original directory identity and marker. Attachment updates
and confirmation commit together after all steps finish. Shared fields and local
observation timestamps remain unchanged.

A failed step or final commit keeps completed disk changes and pending evidence.
Inspection can identify the directory at its source, temporary path or destination.
Layout repair does not move it back automatically. Independent moves in the same
batch may finish, but dependent moves stop when their predecessor fails. The
legacy configuration stays unchanged after a failure.
A later layout invocation leaves pre-existing pending work alone. This also
prevents layout moves from invalidating evidence for pending claims or file changes.
Known collisions discovered before intent creation require no filesystem callback.

`taskspace recover <operationId>` also previews completed directory mutations.
Applying recovery requires the original shared fields and attachment to match
the recorded snapshot. The invoking namespace must still exist. A move or layout
operation requires the exact recorded directory and marker at its destination.
A removal requires the source to be absent. Source-only, intermediate, ambiguous
or unsafe disk states block recovery.

`--apply` commits the recorded label and attachment change, layout attachment
change or shared deletion with journal confirmation in one transaction. Deletion
clears linked card references and retains local metadata. Recovery preserves
creation and local observation timestamps. Layout recovery preserves all shared
fields. It never moves, removes, creates or restores files. Concurrent attempts
serialize on the taskspace queue, and a failed confirmation rolls back database
changes while retaining pending evidence.

Live directory confirmation and explicit recovery share published-state checks.
Before committing, the host verifies the final journal receipt, namespace, shared
record, attachment and completed disk outcome after database
triggers finish. Removal also checks that the shared identity and card links are
absent. Changed evidence rolls back database publication while completed disk work
and newer directory evidence stay in place.

Retained local observations are compared by SQL storage class and value without
converting large integers to JavaScript numbers. REAL values, text and blobs keep
their values too. Shared creation and update timestamps still use the version 1
snapshot format.

Live operations copy shared snapshot values, request fields, callback references
and allowed layout batch IDs before asynchronous work. Filesystem callbacks receive
an immutable directory identity. Direct and temporary layout moves retain completed
disk work when final publication fails. The legacy configuration stays unchanged
after failure and is updated when layout maintenance later finishes.

An operation with a recorded filesystem error requires manual review and cannot
be confirmed this way. The error may describe partial work that completed-state
inspection cannot establish. Abandoned operations are also refused. Repeating
confirmation of an already confirmed operation changes nothing.
After confirming a completed layout, run `doctor --fix` to finish its configuration
update. Configuration changes are outside the recovery transaction.

Inspect and repair disk state before retrying layout maintenance. Use
`taskspace scan --apply` to align an attachment after a manual repair. Explicitly
abandon a reviewed pending tracking record when it no longer needs reconciliation.

```sh
kozane taskspace abandon <operationId> --reason "Reviewed disk and repaired attachment"
kozane taskspace abandon <operationId> --reason "Reviewed disk and repaired attachment" --apply
```

The default is read-only. Applying abandonment records a separate state, reason
and timestamp while preserving the original intent and error. It changes no files,
attachments or shared rows and does not cancel running work. Confirmed operations
cannot be abandoned. Repeating the same decision is idempotent, and a different
reason cannot replace the recorded one. Abandoned operations cannot be confirmed
by the recovery command. Abandoned records stay in recovery exports and
shared restoration preserves them. Pending diagnostics exclude them.

Applying compares the operation with the evidence read before entering the
taskspace queue. Changed identity, intent, creation time or error requires another
inspection. Before committing, the host rereads the abandonment record and verifies
the reason, timestamp and original evidence after database triggers finish.
Trigger changes roll back the abandonment transaction. Identical concurrent
decisions remain idempotent.

The journal has no foreign keys to shared rows. Shared action capture, isolated
validation and shared replacement exclude it alongside `taskspace_local`.
Recovery JSON version 26 includes both tables, local image upload staging,
manifest owners, checkpoint descriptors, shared-history descriptor bindings and
asset descriptor expectations, execution descriptor bindings and original-action
descriptor bindings,
including records for absent
shared identities, file mutations, directory operations and abandonment evidence.
Versions 7–10 import with an empty journal. Version 11–13 records are retained with
empty abandonment fields. Operation paths, directory move destinations and
intermediate layout paths
receive the same containment checks and explicit absolute-path opt-in as local
attachments. Importing a journal does not run its operations.
See [local image upload staging](image-upload-staging.md) for pin and cleanup behavior.

The opt-in action registries accept schema 24 with their existing versioned
semantics. Production action attribution and mandatory capture guards remain
disabled; the journal does not activate them.
