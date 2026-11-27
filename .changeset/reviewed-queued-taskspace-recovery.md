---
"kozane": patch
---

Bind taskspace claim, file and directory recovery to journal evidence captured before queueing. Refuse changed evidence before disk inspection or publication, preserve current files and database rows, and retain idempotent concurrent confirmation when a claim error is cleared.
