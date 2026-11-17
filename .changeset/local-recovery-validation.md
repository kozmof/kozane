---
"@kozane/core": patch
---

Add internal isolated SQL validation for local recovery snapshots. Check identities before database allocation, preserve exact tagged values through constraint validation and read-back, and remove temporary rows before reporting success.
