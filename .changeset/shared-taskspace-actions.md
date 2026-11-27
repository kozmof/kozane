---
"@kozane/core": minor
---

Add database-only taskspace creation, label changes and removal through the
taskspaces service namespace. These services validate namespace access and return
shared fields without reading or changing local attachments.

Add version 2 invocation types and an internal schema-20 action registry for shared
taskspace lifecycle intents. Keep version 1 lifecycle requests local-only. Version 2
compositions retain ordered children and replay without host filesystem callbacks.
