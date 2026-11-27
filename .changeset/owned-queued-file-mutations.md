---
"kozane": patch
---

Capture database context, routing and file mutation intent before waiting in the taskspace queue. Preserve the original save hash and signature, capture directory creation input without yielding, and continue resolving attachments after earlier queued directory moves.
