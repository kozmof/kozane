---
"@kozane/core": minor
"kozane": minor
---

Move taskspace paths, path kinds and last-seen observations into `taskspace_local`
with migration 0020. Shared deletion and restoration retain local attachments for
absent taskspaces. Record readers keep returning the joined taskspace view, and
`getAllTaskspaceLocalMetadata` includes retained attachments for local recovery.

Raw schema consumers must read local fields through `taskspaceLocalTable` or the
taskspace record readers. `taskspaceTable` now contains shared fields only.
Write transaction callbacks receive a distinct handle even when their adapter
reuses the database connection object.

Export database JSON as version 10 with a separate local metadata table. Import
versions 7 through 9 by moving their inline attachment values into local rows.
