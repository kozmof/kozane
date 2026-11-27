---
"kozane": patch
---

Bind local operation abandonment to the inspected intent and error. Refuse evidence changed while queued, verify the final decision after database triggers, and roll back altered abandonment records while preserving pending evidence and idempotent retries.
