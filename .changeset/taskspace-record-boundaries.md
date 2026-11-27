---
"@kozane/core": minor
"kozane": patch
---

Add taskspace record APIs for database creation, label changes, location updates
and deletion inside a caller-owned transaction. Bind taskspace IDs and shared
timestamps when these APIs use an action execution handle. Preserve shared
timestamps during location updates, observations and unchanged-label requests.
