---
"@kozane/core": minor
"kozane": minor
---

Retain local taskspace directory claim intent before touching disk, then confirm it with the local attachment. Report interrupted claims through `kozane doctor` without retrying filesystem work. Include the journal in version 11 local recovery exports and preserve it during shared restoration.
