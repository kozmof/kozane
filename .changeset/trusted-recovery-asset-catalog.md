---
"@kozane/core": minor
"kozane": minor
---

Add migration 0029 with an immutable local catalog of trusted recovery asset descriptors. Require matching original shared and local checkpoint bindings before registration and recheck all three catalogs after content verification. Preserve orphaned historical expectations, exact local snapshots and version 19 JSON exports without installing manifests or images. Extend opt-in action registries to schema 29.
