---
"kozane": minor
---

Protect images required by saved retained recovery manifests through explicit
history and manifest read limits. Verify all six saved sources, reserve before
physical reads, and recheck all seven original catalog bindings and files while
preserving earlier pins after failed verification or commits.
