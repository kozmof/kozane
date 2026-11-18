---
"kozane": minor
---

Add read-only image upload listings and previews, explicit recovery of verified published bytes, and reviewed abandonment of upload pins. Retain intent, errors and decision metadata without repeating filesystem work. Report unfinished uploads through doctor and authenticated startup, and allow normal cleanup of abandoned temporary files only when no live reference or upload pin protects them.
