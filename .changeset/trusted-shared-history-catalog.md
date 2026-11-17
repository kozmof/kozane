---
"@kozane/core": minor
"kozane": minor
---

Add migration 0028 with a local catalog of trusted shared-history descriptors and their original local snapshot bindings. Require matching checkpoint identity and selected history IDs, preserve immutable idempotent registration, and recheck both bindings after shared hash and SQL validation. Include this sixth local table in exact snapshots and version 18 JSON exports while preserving historical descriptor metadata.
