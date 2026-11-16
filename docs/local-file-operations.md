# Local filesystem operation records

Migration `0021_local_file_operation` adds a device-local journal. Its first
supported operation is `taskspace.claim`, version 1, used by HTTP and CLI taskspace
creation. Migration `0022_taskspace_file_operations` adds `taskspace.file`, version
1, for the five file mutation methods. Migration `0023_taskspace_directory_operations`
adds `taskspace.directory`, version 1, for managed directory removal and the legacy
combined rename endpoint. CLI layout maintenance still needs journaling.

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

If attachment or confirmation fails after the marker was written, the host keeps
the directory, shared identity and pending operation. It rolls back attachment
changes. The caller receives a recovery message rather than success. A process
interruption at either durable boundary likewise leaves a pending operation.

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
Repeating confirmation of an already confirmed operation makes no changes.
Blocked claims remain available for manual recovery. Explicit abandonment and
reconciliation for other filesystem operations remain pending.

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
confirm an operation. `doctor --fix` does not retry file work. The directory-claim
recovery command refuses file mutations. Explicit resolution for these operations
remains pending.

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

If the final transaction fails, the completed move or removal remains on disk and
the intent stays pending. The legacy rename endpoint no longer moves a directory
back automatically after a database failure. Partial deletion retains the marker
when the existing filesystem helper can do so. A matching marker does not prove
that all original contents survived a partial deletion.

`doctor` and authenticated startup inspect pending directory operations without
changing them. Inspection reports source and destination presence, marker and
directory identity mismatches, unsafe paths and unreadable evidence. The claim
recovery command refuses these operations. Explicit resolution and journaling
for CLI layout maintenance remain pending. Database-only changes that keep or
already lack a directory do not create a directory journal entry.

The journal has no foreign keys to shared rows. Shared action capture, isolated
validation and shared replacement exclude it alongside `taskspace_local`.
Recovery JSON version 13 includes both tables, including records for absent
shared identities, file mutations and directory operations. Versions 7–10 import
with an empty journal. Version 11 claim records and version 12 file intents are
retained unchanged. Operation paths and directory move destinations
receive the same containment checks and explicit absolute-path opt-in as local
attachments. Importing a journal does not run its operations.

The opt-in action registries accept schema 23 with their existing versioned
semantics. Production action attribution and mandatory capture guards remain
disabled; the journal does not activate them.
