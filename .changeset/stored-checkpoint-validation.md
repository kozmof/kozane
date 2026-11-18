---
"@kozane/core": patch
---

Validate local recovery snapshots against trusted catalog registrations. Refuse missing or changed expectations before preparation succeeds, keep catalog reads outside hashing and isolated SQL validation, and leave installation and activation to their dedicated boundaries.
