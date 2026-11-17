---
"@kozane/core": patch
---

Bind internal local recovery checkpoints to canonical snapshot SHA-256 hashes and UTF-8 byte lengths. Verify separately retained descriptors and trusted identities before isolated SQL validation, and hash captured snapshots after their consistent read transaction closes.
