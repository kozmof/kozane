---
"kozane": minor
---

Add `kozane taskspace attach <taskspaceId> --dir <path>` to attach a local directory to an existing shared taskspace. Preserve shared fields and timestamps, journal intent before disk work, and retain interrupted attachments for explicit recovery without repeating directory creation.
