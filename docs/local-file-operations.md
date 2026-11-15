# Local filesystem operation records

Migration `0021_local_file_operation` adds a device-local journal. Its first
supported operation is `taskspace.claim`, version 1, used by HTTP and CLI taskspace
creation. File writes, directory moves and directory deletion still need journals.

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
retry directory claims. Startup reconciliation and explicit resolution remain
pending.

The journal has no foreign keys to shared rows. Shared action capture, isolated
validation and shared replacement exclude it alongside `taskspace_local`.
Recovery JSON version 11 includes both tables, including records for absent
shared identities. Versions 7–10 import with an empty journal. Operation paths
receive the same containment checks and explicit absolute-path opt-in as local
attachments. Importing a journal does not run its operations.

The opt-in action registries accept schema 21 with their existing versioned
semantics. Production action attribution and mandatory capture guards remain
disabled; the journal does not activate them.
